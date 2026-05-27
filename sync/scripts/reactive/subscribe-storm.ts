/**
 * Reactive-read bench #7 — subscribe-storm (cross-client cache, 1.3+).
 *
 * Measures what changes when N fresh subscribers all open subscriptions to
 * the SAME `(collection, params, ctx)` simultaneously. Before 1.3, each
 * subscribe ran the query body against the DB; now subscribers 2..N hit
 * the in-engine cache instead.
 *
 * Reports:
 *   - Total wall-clock to open all N subscribers and reach `ready`.
 *   - Per-K count of DB-side reader calls (we wrap the registered reader
 *     to count its invocations directly — that's the cleanest "did the
 *     cache work" signal).
 *
 * Run: bun run scripts/reactive/subscribe-storm.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import { ensureSchema, seedTasks, sql } from './tasks-db';
import { waitReady } from './lib';

const PORT = 4370;

type Row = {
	id: string;
	title: string;
	assignee: string;
	priority: number;
	done: boolean;
	createdAt: number;
};

await ensureSchema();
await seedTasks(100);

let readerCalls = 0;
const buildEngine = (cache: 'on' | 'off') => {
	const engine = createSyncEngine(
		cache === 'off' ? { reactiveCache: { max: 0 } } : undefined
	);
	engine.registerReader('tasks', {
		all: async () => {
			readerCalls += 1;
			const rows = await sql<Row[]>`
				select id, title, assignee, priority, done, created_at as "createdAt"
				from rtasks
			`;

			return rows as Row[];
		}
	});
	engine.registerReactive(
		defineReactiveQuery<Row>({
			key: (row) => row.id,
			name: 'tasks',
			run: ({ db }) => db.all<Row>('tasks')
		})
	);

	return engine;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

const stormAtSize = async (
	N: number,
	port: number,
	engine: ReturnType<typeof buildEngine>
) => {
	const url = `ws://localhost:${port}/sync/ws`;
	readerCalls = 0;
	const start = performance.now();

	const subs = Array.from({ length: N }, () =>
		createSyncCollection<Row>({ collection: 'tasks', url })
	);
	await waitReady(
		subs.map((sub, index) => ({
			get: () => sub.get().status,
			label: `sub${index}`
		})),
		600
	);

	const elapsed = performance.now() - start;
	const readerCallsAtEnd = readerCalls;

	for (const sub of subs) sub.close();
	await sleep(100);
	void engine;

	return { N, elapsedMs: elapsed, readerCalls: readerCallsAtEnd };
};

type Row2 = { N: number; elapsedMs: number; readerCalls: number };
const sizes = [1, 10, 100, 1_000];

const runMode = async (mode: 'on' | 'off', port: number) => {
	const engine = buildEngine(mode);
	const app = new Elysia().use(syncSocket({ engine })).listen(port);
	const out: Row2[] = [];
	for (const N of sizes) {
		console.log(
			`# [cache=${mode}] N=${N.toLocaleString('en-US')} fresh subscribers…`
		);
		const result = await stormAtSize(N, port, engine);
		console.log(
			`  all-ready in ${round(result.elapsedMs, 1)} ms · reader called ${result.readerCalls}×`
		);
		out.push(result);
	}
	await app.stop();

	return out;
};

const onResults = await runMode('on', PORT);
// Different port so the second engine doesn't collide.
const offResults = await runMode('off', PORT + 1);

console.log(
	'\n## Subscribe-storm — N fresh subscribers to the same query\n'
);
console.log(
	'| N | cache=on: ready (ms) | cache=on: DB hits | cache=off: ready (ms) | cache=off: DB hits | DB-hit speedup |'
);
console.log('|---|---|---|---|---|---|');
for (let index = 0; index < sizes.length; index += 1) {
	const on = onResults[index]!;
	const off = offResults[index]!;
	const speedup =
		on.readerCalls === 0
			? `${off.readerCalls}× → 0`
			: `${off.readerCalls / on.readerCalls}×`;
	console.log(
		`| ${on.N.toLocaleString('en-US')} | ${round(on.elapsedMs, 1)} | ${on.readerCalls} | ${round(off.elapsedMs, 1)} | ${off.readerCalls} | **${speedup}** |`
	);
}

await sql.end();
process.exit(0);
