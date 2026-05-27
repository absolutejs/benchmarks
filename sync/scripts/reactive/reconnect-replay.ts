/**
 * Reactive-read bench #3 — reconnect-after-offline replay (actual catch-up
 * via `since`, not cold-hydration).
 *
 * Sync ships resume-via-`since`: client tracks `appliedVersion`, on reconnect
 * the subscribe carries `since`, and the engine sends a catch-up diff (or a
 * snapshot if the change log can't cover the gap). This bench measures THAT
 * path — using `disconnect()` (added in @absolutejs/sync 1.2) so the same
 * collection's auto-reconnect loop fires and `appliedVersion` is preserved.
 *
 * Methodology (per iteration):
 *   1. SAME subscriber stays open across iterations — its appliedVersion is
 *      preserved between disconnects.
 *   2. Subscriber `.disconnect()` — closes the WS without losing state.
 *   3. Fire K mutations from the writer (subscriber is offline).
 *   4. Auto-reconnect fires; subscribe carries `since: appliedVersion`.
 *   5. Engine replies with a catch-up diff for the missed (K) changes.
 *   6. Measure from disconnect-end to subscriber seeing the latest value.
 *
 * Repeat for K = 1, 10, 100 missed writes — the catch-up diff should scale
 * with K (small), NOT with the table size.
 *
 * Convex and Zero handle reconnect differently (Convex re-runs queries; Zero
 * uses its WS protocol's incremental delivery). Cross-engine comparison is
 * tricky; we measure sync alone here.
 *
 * Run: bun run scripts/reactive/reconnect-replay.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import {
	bumpTask,
	ensureSchema,
	insertTask,
	readAllTasks,
	sql
} from './tasks-db';
import { waitReady, withTimeout } from './lib';
import { computeStats } from '../lib/measure';

const PORT = 4352;

type Row = {
	id: string;
	title: string;
	assignee: string;
	priority: number;
	done: boolean;
	createdAt: number;
};

await ensureSchema();
await sql`truncate rtasks`;
await insertTask({
	assignee: 'alex',
	createdAt: 0,
	done: false,
	id: 'one',
	priority: 0,
	title: 'one'
});

const engine = createSyncEngine();
engine.registerReader('tasks', { all: () => readAllTasks() });
engine.registerWriter<Row>('tasks', {
	delete: () => {},
	insert: async (row: Row) => insertTask(row),
	update: async (row: { id: string }) =>
		(await bumpTask(row.id)) ?? {
			assignee: 'alex',
			createdAt: 0,
			done: false,
			id: row.id,
			priority: 0,
			title: ''
		}
});
engine.registerReactive(
	defineReactiveQuery<Row>({
		key: (row) => row.id,
		name: 'tasks',
		run: ({ db }) => db.all<Row>('tasks')
	})
);
engine.registerMutation(
	defineMutation({
		handler: (_args, _ctx, actions) =>
			actions.update<Row>('tasks', { id: 'one' }),
		name: 'bump'
	})
);

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = `ws://localhost:${PORT}/sync/ws`;

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

const priorityOf = (state: { data: Array<{ priority?: number }> }): number => {
	const row = state.data[0];

	return typeof row?.priority === 'number' ? row.priority : -1;
};

const writer = createSyncCollection<Row>({ collection: 'tasks', url });
await waitReady([{ get: () => writer.get().status, label: 'writer' }]);

// ONE subscriber stays open across all iterations so its appliedVersion
// survives disconnect()s — the resumed subscribe carries `since` and the
// engine sends a catch-up diff. The old version of this bench used fresh
// `createSyncCollection`s per iteration (no `since`), which silently
// measured cold-hydration cost instead of the resume path.
//
// reconnectMs is set wide enough that all of an iteration's missed writes
// land BEFORE the auto-reconnect fires — otherwise we'd accidentally
// measure "saw writes live" rather than "caught up after reconnect."
// Each iteration's reported elapsed subtracts the reconnect wait, so what
// we report is the catch-up cost itself (reconnect → up-to-date), not the
// backoff window.
const RECONNECT_MS = 2_000;
const subscriber = createSyncCollection<Row>({
	collection: 'tasks',
	reconnectMs: RECONNECT_MS,
	url
});
await waitReady([{ get: () => subscriber.get().status, label: 'subscriber' }]);

const measureGap = async (missedWrites: number) => {
	const measured = 10;
	const samples: number[] = [];
	const start = performance.now();

	const RECONNECT_TIMEOUT_MS = 30_000;
	for (let iteration = 0; iteration < measured; iteration += 1) {
		const beforeOffline = priorityOf(subscriber.get());
		// Close the WS without losing state — auto-reconnect will fire after
		// RECONNECT_MS and the resumed subscribe will carry `since`.
		subscriber.disconnect();
		// Tiny pause so ws.onclose propagates → client.connected = false.
		await sleep(10);

		// Fire all K missed writes while offline. Writer's separate connection
		// is unaffected.
		for (let index = 0; index < missedWrites; index += 1) {
			await writer.mutate({ args: {}, name: 'bump' });
		}
		const expectedAfter = beforeOffline + missedWrites;

		// At this point the writes are done; the subscriber is still offline
		// (auto-reconnect timer hasn't fired). We want to measure the *catch-up*
		// — from when the subscriber's reconnect kicks off to when it's
		// up-to-date — not the artificial backoff window. So we time from
		// "subscriber goes from `closed` back to `connecting`" (the moment
		// the new WS starts opening).
		let catchupStart = 0;
		let unsubscribe: () => void = () => {};
		const inner = new Promise<number>((resolve) => {
			unsubscribe = subscriber.subscribe((state) => {
				if (catchupStart === 0 && state.status === 'connecting') {
					catchupStart = performance.now();
				}
				if (
					catchupStart !== 0 &&
					priorityOf(state) >= expectedAfter
				) {
					unsubscribe();
					resolve(performance.now() - catchupStart);
				}
			});
		});
		const elapsed = await withTimeout(
			inner,
			RECONNECT_TIMEOUT_MS,
			`reconnect catching up to priority=${expectedAfter}`,
			() => {
				unsubscribe();
			}
		);
		samples.push(elapsed);
	}

	return computeStats(samples, performance.now() - start);
};

const results: Array<{
	missed: number;
	p50: number;
	p95: number;
	max: number;
}> = [];
for (const missed of [1, 10, 100]) {
	console.log(`# missed writes: ${missed}…`);
	const stats = await measureGap(missed);
	console.log(
		`  reconnect→fresh state: p50 ${round(stats.p50, 2)} ms · p95 ${round(stats.p95, 2)} ms · max ${round(stats.max, 2)} ms`
	);
	results.push({
		max: stats.max,
		missed,
		p50: stats.p50,
		p95: stats.p95
	});
}

console.log(
	'\n## Reconnect-after-offline — catch-up via `since` (sync 1.2+)\n'
);
console.log('| missed writes | p50 (ms) | p95 (ms) | max (ms) |');
console.log('|---|---|---|---|');
for (const row of results) {
	console.log(
		`| ${row.missed} | ${round(row.p50, 1)} | ${round(row.p95, 1)} | ${round(row.max, 1)} |`
	);
}

subscriber.close();
writer.close();
void app.stop();
await sql.end();
process.exit(0);
