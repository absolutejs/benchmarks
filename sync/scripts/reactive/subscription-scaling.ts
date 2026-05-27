/**
 * Reactive-read bench #1 — subscription scaling.
 *
 * The qualitative thing live-query engines exist for: ONE writer mutates,
 * N subscribers receive the update. How does per-subscriber latency degrade
 * as N grows? This is where naïve fan-out implementations choke (O(N) work
 * per change), and where careful per-query deduplication + batching pays off.
 *
 * Methodology: spin up the sync engine + one Elysia socket, attach N
 * subscriber clients to the `tasks` collection (or a single-row variant for
 * a smaller, more easily-fan-out-able subscription), then fire 50 sequential
 * mutations. For each mutation, measure the time from issuing the write to
 * the SLOWEST subscriber receiving the update — that's the user-visible
 * fan-out tail.
 *
 * Run: bun run scripts/reactive/subscription-scaling.ts
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
import { computeStats } from '../lib/measure';

const PORT = 4350;

type Row = {
	id: string;
	title: string;
	assignee: string;
	priority: number;
	done: boolean;
	createdAt: number;
};

await ensureSchema();
// Single row that the writer bumps — keeps the fan-out workload "every
// subscriber gets one row's worth of diff" rather than entangling with
// row-count effects (that's the cold-hydration bench's job).
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

const measureAtScale = async (subscribers: number) => {
	const writer = createSyncCollection<Row>({ collection: 'tasks', url });
	const subs = Array.from({ length: subscribers }, () =>
		createSyncCollection<Row>({ collection: 'tasks', url })
	);
	// Wait for everything to reach ready.
	for (let attempt = 0; attempt < 600; attempt += 1) {
		const allReady =
			writer.get().status === 'ready' &&
			subs.every((sub) => sub.get().status === 'ready');
		if (allReady) break;
		await sleep(50);
	}
	if (
		writer.get().status !== 'ready' ||
		subs.some((sub) => sub.get().status !== 'ready')
	) {
		writer.close();
		for (const sub of subs) sub.close();
		throw new Error(
			`subscribers never all became ready at N=${subscribers}`
		);
	}

	const priorityOf = (
		state: ReturnType<(typeof subs)[number]['get']>
	): number => {
		const row = state.data[0];

		return typeof row?.priority === 'number' ? row.priority : -1;
	};

	let lastSeen = priorityOf(subs[0]?.get() ?? { data: [], status: 'ready' });

	const iterations = 25;
	const tail: number[] = []; // slowest-subscriber latency per iteration
	const fanoutSum: number[] = []; // total fan-out wallclock per iteration

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const expected = lastSeen + 1;
		const startedAt = performance.now();
		// Each subscriber resolves when it sees `expected`. We take the max
		// (slowest-tail) per iteration — that's user-visible.
		const subscriberReceived = subs.map(
			(sub) =>
				new Promise<number>((resolve) => {
					const unsubscribe = sub.subscribe((state) => {
						if (priorityOf(state) >= expected) {
							unsubscribe();
							resolve(performance.now() - startedAt);
						}
					});
				})
		);
		await writer.mutate({ args: {}, name: 'bump' });
		const arrivals = await Promise.all(subscriberReceived);
		lastSeen = expected;
		tail.push(Math.max(...arrivals));
		fanoutSum.push(performance.now() - startedAt);
	}

	const tailStats = computeStats(tail, fanoutSum.reduce((a, b) => a + b, 0));

	for (const sub of subs) sub.close();
	writer.close();
	// Let the engine clean up subscriptions before the next scale step.
	await sleep(200);

	return tailStats;
};

const results: Array<{ N: number; p50: number; p95: number; p99: number }> = [];
for (const N of [1, 10, 100, 1_000]) {
	console.log(`# subscribers=${N}…`);
	const stats = await measureAtScale(N);
	console.log(
		`  slowest-subscriber per write: p50 ${round(stats.p50, 2)} ms · p95 ${round(stats.p95, 2)} ms · p99 ${round(stats.p99, 2)} ms · max ${round(stats.max, 2)} ms`
	);
	results.push({
		N,
		p50: stats.p50,
		p95: stats.p95,
		p99: stats.p99
	});
}

console.log(
	'\n## Subscription scaling — slowest-subscriber latency per write\n'
);
console.log(
	'| subscribers | tail p50 (ms) | tail p95 (ms) | tail p99 (ms) |'
);
console.log('|---|---|---|---|');
for (const row of results) {
	console.log(
		`| ${row.N.toLocaleString('en-US')} | ${round(row.p50, 2)} | ${round(row.p95, 2)} | ${round(row.p99, 2)} |`
	);
}

void app.stop();
await sql.end();
process.exit(0);
