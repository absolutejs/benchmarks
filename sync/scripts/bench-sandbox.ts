/**
 * Sandbox-backend benchmark — `@absolutejs/sync` `sandboxedHandler` running
 * the same string-form mutation through `@absolutejs/isolated-jsc`'s Worker
 * backend and its FFI backend (libJavaScriptCore via `bun:ffi`). Same engine,
 * same handler source, same Postgres backing store as bench-sync.ts.
 *
 * Three lanes per backend:
 *   1. Cold dispatch — first call pays compile + isolate spawn (Worker:
 *      spawn cost; FFI: dlopen + JSContextGroupCreate). Reported as a
 *      single-shot latency.
 *   2. Warm dispatch — subsequent calls reuse the isolate; only the
 *      per-call context spin-up + run is measured. Sequential awaited.
 *   3. Sustained throughput — same loop, longer N, with `measure` →
 *      writes/sec + full distribution.
 *
 * Plus a one-shot "async actions roundtrip" lane that exercises the path
 * that drove the 0.4 fix: a sandboxed handler calling `actions.change(...)`
 * (an async Reference). 0.3 would have thrown "Promise that doesn't settle
 * synchronously" on FFI; 0.4 pumps it.
 *
 * Run: `bun run scripts/bench-sandbox.ts`
 */
import { defineCollection, defineMutation } from '@absolutejs/sync/engine';
import { createSyncEngine } from '@absolutejs/sync/engine';
import { measure, computeStats } from './lib/measure';
import type { Stats } from './lib/measure';

type Backend = 'worker' | 'ffi';

type Item = { id: number; n: number };

const itemsCollection = (name: string) =>
	defineCollection<Item>({
		hydrate: () => [],
		key: (row) => row.id,
		match: () => true,
		name
	});

// Two handler shapes per lane:
//  - PURE: derives a value from args + ctx, returns it. No actions calls.
//    This is the lane where FFI shows its cold-heap + interrupt-driven
//    timeout advantages cleanly. 0.3 already supported this on FFI.
//  - ACTIONS: calls `actions.change('items', ...)` — an async Reference
//    that 0.3 couldn't pump on FFI (the lane 0.4 unblocked).
const PURE_HANDLER = `(args) => args.n * 2`;
const ACTIONS_HANDLER = `async (args, ctx, actions) => {
	await actions.change('items', { op: 'insert', row: { id: args.id, n: args.id } });
	return args.id;
}`;

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

const runLane = async (
	label: string,
	backend: Backend,
	handler: string,
	makeArgs: (i: number) => Record<string, unknown>,
	count: number
): Promise<{ cold: number; warm: Stats }> => {
	const engine = createSyncEngine();
	engine.register(itemsCollection('items'));
	engine.registerMutation(
		defineMutation({
			name: 'm',
			// 1 GB cap: each per-call context retains JSC metadata until the
			// next GC sweep (~2 MB residual per call). At N=500 we'd otherwise
			// trip the Worker's cap mid-bench.
			sandbox: { backend, memoryLimit: 1024, timeout: 5000 },
			sandboxedHandler: handler
		})
	);

	// Cold: pay compile + isolate spawn on the very first call.
	const coldStart = performance.now();
	await engine.runMutation('m', makeArgs(0), {});
	const cold = performance.now() - coldStart;

	// Warm: same isolate, fresh context per call. Sequential awaited.
	let i = 1;
	const warm = await measure({
		count,
		warmup: 8,
		work: async () => {
			await engine.runMutation('m', makeArgs(i++), {});
		}
	});

	const line =
		`  [${backend.toUpperCase().padEnd(6)}] ${label.padEnd(28)} ` +
		`cold ${round(cold, 1).padStart(7)} ms · ` +
		`warm p50 ${round(warm.p50, 2).padStart(6)} ms · ` +
		`p95 ${round(warm.p95, 2).padStart(6)} ms · ` +
		`mean ${round(warm.mean, 2).padStart(6)} ms · ` +
		`${Math.round(warm.throughput).toLocaleString('en-US').padStart(5)} ops/sec`;
	console.log(line);
	return { cold, warm };
};

// Probe: can we even resolve libJSC for FFI? If not, skip FFI lanes cleanly
// instead of crashing the bench mid-table.
const ffiAvailable = await (async () => {
	try {
		const { resolveJscLibrary } = await import('@absolutejs/isolated-jsc');
		const path = resolveJscLibrary();
		return path !== undefined;
	} catch {
		return false;
	}
})();

console.log('# Sandbox backend bench — sync.sandboxedHandler (Worker vs FFI)');
console.log('');
console.log(
	`  isolated-jsc backends available: worker=true, ffi=${ffiAvailable}`
);
console.log('');

console.log('## Lane 1 — pure handler (no `actions.*`, derived return value)');
const pureWorker = await runLane(
	'pure handler',
	'worker',
	PURE_HANDLER,
	(i) => ({ n: i }),
	500
);
const pureFfi = ffiAvailable
	? await runLane(
			'pure handler',
			'ffi',
			PURE_HANDLER,
			(i) => ({ n: i }),
			500
		)
	: undefined;
console.log('');

console.log(
	'## Lane 2 — async actions (`actions.change`, an async Reference)'
);
console.log('  (lane that drove the 0.4 fix — 0.3 FFI errored here)');
const actionsWorker = await runLane(
	'actions.change',
	'worker',
	ACTIONS_HANDLER,
	(i) => ({ id: 100_000 + i }),
	200
);
const actionsFfi = ffiAvailable
	? await runLane(
			'actions.change',
			'ffi',
			ACTIONS_HANDLER,
			(i) => ({ id: 200_000 + i }),
			200
		)
	: undefined;
console.log('');

const row = (
	lane: string,
	backend: string,
	cold: number,
	stats: Stats
): string =>
	`| ${lane} | ${backend} | ${round(cold, 1)} | ${round(stats.p50, 2)} | ${round(stats.p95, 2)} | ${round(stats.mean, 2)} | ${Math.round(stats.throughput).toLocaleString('en-US')} |`;

console.log('## Lane 3 — many-tenant cold spawn (per-tenant isolation)');
console.log(
	'  N independent mutations, each gets its own isolate. Reports total'
);
console.log(
	'  wall-clock to spawn + first-call all of them + RSS delta. This is the'
);
console.log(
	'  multi-tenant scenario where FFI\'s ~300 KB cold heap matters most.'
);
const spawnLane = async (
	backend: Backend,
	tenants: number
): Promise<{ totalMs: number; rssDeltaMb: number }> => {
	const beforeRss = process.memoryUsage.rss();
	const start = performance.now();
	const engine = createSyncEngine();
	engine.register(itemsCollection('items'));
	for (let i = 0; i < tenants; i += 1) {
		engine.registerMutation(
			defineMutation({
				name: `m_${backend}_${i}`,
				sandbox: {
					backend,
					memoryLimit: 64,
					timeout: 5000
				},
				sandboxedHandler: `(args) => args.tenant + '-' + args.n`
			})
		);
	}
	// First call per mutation triggers compile + isolate spawn.
	for (let i = 0; i < tenants; i += 1) {
		await engine.runMutation(`m_${backend}_${i}`, { n: 1, tenant: i }, {});
	}
	const totalMs = performance.now() - start;
	const rssDeltaMb = (process.memoryUsage.rss() - beforeRss) / 1024 / 1024;
	console.log(
		`  [${backend.toUpperCase().padEnd(6)}] ${tenants} tenants: ` +
			`${round(totalMs, 0).padStart(6)} ms total (${round(totalMs / tenants, 1)} ms/tenant) · ` +
			`RSS +${round(rssDeltaMb, 0)} MB`
	);
	return { rssDeltaMb, totalMs };
};
const spawnWorker = await spawnLane('worker', 20);
const spawnFfi = ffiAvailable ? await spawnLane('ffi', 20) : undefined;
console.log('');

// Markdown summary row for pasting into RESULTS.md.
console.log('## Markdown rows');
console.log('');
console.log(
	'| Lane | Backend | cold (ms) | warm p50 (ms) | warm p95 (ms) | mean (ms) | ops/sec |'
);
console.log(
	'| ---- | ------- | --------- | ------------- | ------------- | --------- | ------- |'
);
console.log(row('pure', 'worker', pureWorker.cold, pureWorker.warm));
if (pureFfi !== undefined)
	console.log(row('pure', 'ffi', pureFfi.cold, pureFfi.warm));
console.log(
	row('actions.change', 'worker', actionsWorker.cold, actionsWorker.warm)
);
if (actionsFfi !== undefined)
	console.log(
		row('actions.change', 'ffi', actionsFfi.cold, actionsFfi.warm)
	);
console.log('');
console.log('| Multi-tenant lane | Backend | tenants | total cold (ms) | per-tenant (ms) | RSS Δ (MB) |');
console.log('| ----------------- | ------- | ------- | --------------- | --------------- | ---------- |');
console.log(
	`| 20-tenant spawn | worker | 20 | ${round(spawnWorker.totalMs, 0)} | ${round(spawnWorker.totalMs / 20, 1)} | ${round(spawnWorker.rssDeltaMb, 0)} |`
);
if (spawnFfi !== undefined) {
	console.log(
		`| 20-tenant spawn | ffi | 20 | ${round(spawnFfi.totalMs, 0)} | ${round(spawnFfi.totalMs / 20, 1)} | ${round(spawnFfi.rssDeltaMb, 0)} |`
	);
}
console.log('');

// Suppress the unused-stats warning from computeStats if a lane is skipped.
void computeStats;

process.exit(0);
