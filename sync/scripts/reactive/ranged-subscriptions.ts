/**
 * Reactive-read bench #4 — ranged subscriptions.
 *
 * Real workloads aren't "subscribe to one row" — they're "subscribe to my
 * tasks ordered by priority." Two interesting axes:
 *   1. Initial-snapshot latency for a `where assignee = ? order by priority`
 *      query at different table sizes.
 *   2. Per-write update latency when ONE matching row changes (the engine
 *      should re-rank, not re-execute the whole query).
 *
 * The reactive query here re-runs on every change to `tasks` (sync's read-set
 * tracking). At large table sizes, the cost shows whether `db.all` -> filter
 * client-side is the practice (slow) or whether the engine pushes the filter
 * down via a SQL where clause (fast). Today we use db.all + client-side
 * filter inside `run` — measures the current default, not the ceiling.
 *
 * Run: bun run scripts/reactive/ranged-subscriptions.ts
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
	seedTasks,
	sql
} from './tasks-db';
import { waitReady, withTimeout } from './lib';
import { computeStats } from '../lib/measure';

const PORT = 4353;

type Row = {
	id: string;
	title: string;
	assignee: string;
	priority: number;
	done: boolean;
	createdAt: number;
};

await ensureSchema();

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
// A ranged reactive query — params drive the filter. The engine re-runs the
// query body on every change to `tasks`; this measures that re-run cost.
// Using `ctx.db.all` + client-side filter is the default path most users will
// write — it costs O(table size), and that's what we're measuring.
engine.registerReactive(
	defineReactiveQuery<Row, string>({
		key: (row) => row.id,
		name: 'tasksByAssignee',
		run: async ({ db, params }) => {
			const all = await db.all<Row>('tasks');

			return all
				.filter((row) => row.assignee === params)
				.sort((a, b) => a.priority - b.priority);
		}
	})
);
engine.registerMutation(
	defineMutation({
		handler: (args: { id: string }, _ctx, actions) =>
			actions.update<Row>('tasks', { id: args.id }),
		name: 'bumpTask'
	})
);

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = `ws://localhost:${PORT}/sync/ws`;

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

const ASSIGNEE = 'alex';

const measureRangedAtSize = async (rowCount: number) => {
	await seedTasks(rowCount);
	await sleep(150);

	// (a) Cold subscribe — time-to-ready for the ranged query
	const coldSamples: number[] = [];
	const warmupCold = 3;
	const measuredCold = 10;
	const COLD_TIMEOUT_MS = 30_000;
	const runCold = (): Promise<number> => {
		const startedAt = performance.now();
		const sub = createSyncCollection<Row>({
			collection: 'tasksByAssignee',
			params: ASSIGNEE,
			url
		});
		let unsubscribe: () => void = () => {};
		const inner = new Promise<number>((resolve) => {
			unsubscribe = sub.subscribe((state) => {
				if (state.status === 'ready') {
					unsubscribe();
					sub.close();
					resolve(performance.now() - startedAt);
				}
			});
		});

		return withTimeout(inner, COLD_TIMEOUT_MS, 'ranged cold subscribe', () => {
			unsubscribe();
			sub.close();
		});
	};
	for (let index = 0; index < warmupCold; index += 1) await runCold();
	for (let index = 0; index < measuredCold; index += 1) {
		coldSamples.push(await runCold());
	}
	const coldStats = computeStats(
		coldSamples,
		coldSamples.reduce((a, b) => a + b, 0)
	);

	// (b) Live-update — keep one subscriber open, mutate one matching row,
	// measure the time from issuing the write to the subscriber seeing it.
	const subscriber = createSyncCollection<Row>({
		collection: 'tasksByAssignee',
		params: ASSIGNEE,
		url
	});
	const writer = createSyncCollection<Row>({
		collection: 'tasksByAssignee',
		params: ASSIGNEE,
		url
	});
	await waitReady(
		[
			{ get: () => subscriber.get().status, label: 'subscriber' },
			{ get: () => writer.get().status, label: 'writer' }
		],
		200
	);

	const matchingId = subscriber.get().data[0]?.id;
	if (matchingId === undefined) {
		throw new Error('no matching rows for live-update phase');
	}

	const liveSamples: number[] = [];
	const measuredLive = 15;
	const LIVE_TIMEOUT_MS = 30_000;
	for (let iteration = 0; iteration < measuredLive; iteration += 1) {
		const before =
			subscriber.get().data.find((row) => row.id === matchingId)
				?.priority ?? 0;
		const startedAt = performance.now();
		let unsubscribe: () => void = () => {};
		const inner = new Promise<number>((resolve) => {
			unsubscribe = subscriber.subscribe((state) => {
				const next = state.data.find((row) => row.id === matchingId);
				if (
					next !== undefined &&
					typeof next.priority === 'number' &&
					next.priority > before
				) {
					unsubscribe();
					resolve(performance.now() - startedAt);
				}
			});
		});
		const seen = withTimeout(
			inner,
			LIVE_TIMEOUT_MS,
			`ranged live update id=${matchingId} priority>${before}`,
			() => unsubscribe()
		);
		await writer.mutate({ args: { id: matchingId }, name: 'bumpTask' });
		liveSamples.push(await seen);
	}
	const liveStats = computeStats(
		liveSamples,
		liveSamples.reduce((a, b) => a + b, 0)
	);

	subscriber.close();
	writer.close();
	await sleep(100);

	return { cold: coldStats, live: liveStats };
};

const results: Array<{
	rows: number;
	coldP50: number;
	coldP95: number;
	liveP50: number;
	liveP95: number;
}> = [];
for (const rows of [1_000, 10_000, 100_000]) {
	console.log(`# ${rows.toLocaleString('en-US')} rows in table…`);
	const out = await measureRangedAtSize(rows);
	console.log(
		`  cold subscribe: p50 ${round(out.cold.p50, 1)} ms · p95 ${round(out.cold.p95, 1)} ms`
	);
	console.log(
		`  live update:    p50 ${round(out.live.p50, 1)} ms · p95 ${round(out.live.p95, 1)} ms`
	);
	results.push({
		coldP50: out.cold.p50,
		coldP95: out.cold.p95,
		liveP50: out.live.p50,
		liveP95: out.live.p95,
		rows
	});
}

console.log(
	'\n## Ranged subscriptions — `tasks where assignee=alex order by priority`\n'
);
console.log(
	'| rows in table | cold p50 (ms) | cold p95 (ms) | live update p50 (ms) | live update p95 (ms) |'
);
console.log('|---|---|---|---|---|');
for (const row of results) {
	console.log(
		`| ${row.rows.toLocaleString('en-US')} | ${round(row.coldP50, 1)} | ${round(row.coldP95, 1)} | ${round(row.liveP50, 1)} | ${round(row.liveP95, 1)} |`
	);
}

void app.stop();
await sql.end();
process.exit(0);
