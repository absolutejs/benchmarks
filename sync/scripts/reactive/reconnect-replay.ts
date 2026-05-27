/**
 * Reactive-read bench #3 — reconnect-after-offline replay.
 *
 * Sync ships local-first (IndexedDB cache, offline queue, resume-from-cached-
 * version on reconnect). This bench measures the path that matters for that
 * promise: how long from "subscriber reconnects after the server moved on N
 * versions" to "subscriber is up to date again."
 *
 * Methodology:
 *   1. Open a subscriber, let it hydrate fully.
 *   2. Disconnect the subscriber (close socket).
 *   3. Fire K mutations while the subscriber is offline (writer is still
 *      connected).
 *   4. Reconnect the subscriber.
 *   5. Measure time from reconnect to the subscriber seeing the latest value.
 *
 * Repeat for K = 1, 10, 100 missed writes — does the resume cost scale with
 * the gap, or is the engine's diff-from-version path constant?
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

const measureGap = async (missedWrites: number) => {
	const measured = 10;
	const samples: number[] = [];
	const start = performance.now();

	const RECONNECT_TIMEOUT_MS = 15_000;
	for (let iteration = 0; iteration < measured; iteration += 1) {
		// Fresh subscriber per iteration so each measurement is a true
		// reconnect (not a "subscription that was just opened" case).
		const sub = createSyncCollection<Row>({ collection: 'tasks', url });
		await waitReady([{ get: () => sub.get().status, label: 'sub' }]);

		const beforeOffline = priorityOf(sub.get());
		// Disconnect.
		sub.close();
		await sleep(50);

		// Fire missedWrites mutations from the writer while offline.
		for (let index = 0; index < missedWrites; index += 1) {
			await writer.mutate({ args: {}, name: 'bump' });
		}
		const expectedAfter = beforeOffline + missedWrites;

		// Reconnect — measure ready→up-to-date.
		const reconnectStarted = performance.now();
		const fresh = createSyncCollection<Row>({
			collection: 'tasks',
			url
		});
		let unsubscribe: () => void = () => {};
		const inner = new Promise<number>((resolve) => {
			unsubscribe = fresh.subscribe((state) => {
				if (priorityOf(state) >= expectedAfter) {
					unsubscribe();
					resolve(performance.now() - reconnectStarted);
				}
			});
		});
		const elapsed = await withTimeout(
			inner,
			RECONNECT_TIMEOUT_MS,
			`reconnect catching up to priority=${expectedAfter}`,
			() => {
				unsubscribe();
				fresh.close();
			}
		);
		fresh.close();
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
	'\n## Reconnect-after-offline — fresh subscriber catches up to current\n'
);
console.log('| missed writes | p50 (ms) | p95 (ms) | max (ms) |');
console.log('|---|---|---|---|');
for (const row of results) {
	console.log(
		`| ${row.missed} | ${round(row.p50, 1)} | ${round(row.p95, 1)} | ${round(row.max, 1)} |`
	);
}

writer.close();
void app.stop();
await sql.end();
process.exit(0);
