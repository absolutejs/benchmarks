/**
 * Reactive-read bench #4b — ranged subscriptions via `defineGraphCollection`.
 *
 * Direct comparison to `ranged-subscriptions.ts` (which uses the default
 * `defineReactiveQuery` + `ctx.db.all` + JS filter — O(table) per change).
 * This one wires the SAME query (`tasks where assignee=$me ORDER BY priority`)
 * through sync's incremental operator graph: `query(source).orderBy(...)`. The
 * source's `hydrate` pushes the filter to SQL, and incremental changes are
 * routed through `match` so the graph stays small.
 *
 * Hypothesis: live-update latency stays bounded — independent of table size —
 * because only the affected row flows through this subscription's pipeline.
 * If borne out, the recommended pattern for large tables is `defineGraph-
 * Collection`, and the O(table size) finding in the original ranged bench
 * is a "default-path cost," not an engine ceiling.
 *
 * Run: bun run scripts/reactive/ranged-subscriptions-graph.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineGraphCollection,
	defineMutation,
	query
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import {
	bumpTask,
	ensureSchema,
	insertTask,
	readAllTasks,
	readTasksByAssignee,
	seedTasks,
	sql
} from './tasks-db';
import { waitReady, withTimeout } from './lib';
import { computeStats } from '../lib/measure';

const PORT = 4355;

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

// THIS is the difference vs ranged-subscriptions.ts: a graph collection. The
// source's `hydrate` runs the filtered SQL once; `match` keeps incremental
// changes scoped to rows that actually belong to this subscriber's view; the
// `orderBy` operator maintains a sorted top-N incrementally.
engine.registerGraph(
	defineGraphCollection<Row, string>({
		key: (row) => row.id,
		name: 'tasksByAssigneeGraph',
		query: query<Row, string>({
			hydrate: (assignee) => readTasksByAssignee(assignee, true),
			key: (row) => row.id,
			match: (row, assignee) => row.assignee === assignee,
			table: 'tasks'
		}).orderBy({
			compare: (a, b) => a.priority - b.priority,
			key: (row) => row.id
		})
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

const measureAtSize = async (rowCount: number) => {
	await seedTasks(rowCount);
	await sleep(150);

	// Cold subscribe — time-to-ready for the graph-backed ranged query
	const coldSamples: number[] = [];
	const warmupCold = 3;
	const measuredCold = 10;
	const COLD_TIMEOUT_MS = 30_000;
	const runCold = (): Promise<number> => {
		const startedAt = performance.now();
		const sub = createSyncCollection<Row>({
			collection: 'tasksByAssigneeGraph',
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

		return withTimeout(
			inner,
			COLD_TIMEOUT_MS,
			'ranged-graph cold subscribe',
			() => {
				unsubscribe();
				sub.close();
			}
		);
	};
	for (let index = 0; index < warmupCold; index += 1) await runCold();
	for (let index = 0; index < measuredCold; index += 1) {
		coldSamples.push(await runCold());
	}
	const coldStats = computeStats(
		coldSamples,
		coldSamples.reduce((a, b) => a + b, 0)
	);

	// Live-update — keep one subscriber open, mutate one matching row, measure
	const subscriber = createSyncCollection<Row>({
		collection: 'tasksByAssigneeGraph',
		params: ASSIGNEE,
		url
	});
	const writer = createSyncCollection<Row>({
		collection: 'tasksByAssigneeGraph',
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
			`ranged-graph live update id=${matchingId} priority>${before}`,
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
	console.log(`# ${rows.toLocaleString('en-US')} rows in table (graph)…`);
	const out = await measureAtSize(rows);
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
	'\n## Ranged subscriptions (graph collection) — `tasks where assignee=alex order by priority`\n'
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
