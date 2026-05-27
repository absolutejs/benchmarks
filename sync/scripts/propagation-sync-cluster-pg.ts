/**
 * @absolutejs/sync propagation latency across a REAL PG-NOTIFY cluster bus.
 *
 * Companion to `propagation-sync-cluster.ts` (in-memory bus). This one wires
 * two engines via `@absolutejs/sync-bus-pg` so the cross-instance hop carries
 * the actual NOTIFY round-trip cost. Same harness shape as the in-memory
 * variant; difference is only the bus.
 *
 * Run: bun run scripts/propagation-sync-cluster-pg.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import { createPostgresClusterBus } from '@absolutejs/sync-bus-pg';
import postgres from 'postgres';
import { bumpCounter, readCounter, sql } from '../shared/counter-db';
import { computeStats } from './lib/measure';

const PORT_A = 4341;
const PORT_B = 4342;

type Row = { id: string; n: number };

const makeEngine = () => {
	const engine = createSyncEngine();
	engine.registerReader('counter', {
		all: async () => [{ id: 'c', n: await readCounter() }]
	});
	engine.registerWriter<Row>('counter', {
		delete: () => {},
		insert: async () => ({ id: 'c', n: await readCounter() }),
		update: async () => ({ id: 'c', n: await bumpCounter() })
	});
	engine.registerReactive(
		defineReactiveQuery<Row>({
			key: (row) => row.id,
			name: 'counter',
			run: async ({ db }) => db.all<Row>('counter')
		})
	);
	engine.registerMutation(
		defineMutation({
			handler: (_args, _ctx, actions) =>
				actions.update<Row>('counter', { id: 'c' }),
			name: 'bump'
		})
	);

	return engine;
};

// Two PG clients — one per bus instance — so each engine has its own
// dedicated LISTEN connection (postgres-js opens one per listen() call).
const busSqlA = postgres('postgresql://postgres:postgres@localhost:54330/zbench', { max: 5 });
const busSqlB = postgres('postgresql://postgres:postgres@localhost:54330/zbench', { max: 5 });

// Unique channel per run so concurrent benches don't bleed into each other.
const channel = `sync_bench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const busA = createPostgresClusterBus({ sql: busSqlA, channel });
const busB = createPostgresClusterBus({ sql: busSqlB, channel });

const engineA = makeEngine();
const engineB = makeEngine();
await engineA.connectCluster(busA);
await engineB.connectCluster(busB);

const appA = new Elysia().use(syncSocket({ engine: engineA })).listen(PORT_A);
const appB = new Elysia().use(syncSocket({ engine: engineB })).listen(PORT_B);

const sleep = (timeMs: number) =>
	new Promise((resolve) => setTimeout(resolve, timeMs));

const urlA = `ws://localhost:${PORT_A}/sync/ws`;
const urlB = `ws://localhost:${PORT_B}/sync/ws`;
const writer = createSyncCollection<Row>({ collection: 'counter', url: urlA });
const subscriber = createSyncCollection<Row>({
	collection: 'counter',
	url: urlB
});

for (let attempt = 0; attempt < 100; attempt += 1) {
	if (
		writer.get().status === 'ready' &&
		subscriber.get().status === 'ready'
	) {
		break;
	}
	await sleep(50);
}
if (
	writer.get().status !== 'ready' ||
	subscriber.get().status !== 'ready'
) {
	throw new Error(
		`cluster clients never became ready (writer=${writer.get().status}, subscriber=${subscriber.get().status})`
	);
}

const nOf = (state: ReturnType<typeof subscriber.get>): number => {
	const row = state.data[0];

	return typeof row?.n === 'number' ? row.n : -1;
};

let lastSeen = nOf(subscriber.get());

const ITERATION_TIMEOUT_MS = 10_000;

const propagate = (): Promise<number> =>
	new Promise<number>((resolve, reject) => {
		const startedAt = performance.now();
		const expected = lastSeen + 1;
		const timer = setTimeout(() => {
			unsubscribe();
			reject(
				new Error(
					`sync PG-bus propagation timed out after ${ITERATION_TIMEOUT_MS} ms (expected n=${expected}, last seen=${lastSeen})`
				)
			);
		}, ITERATION_TIMEOUT_MS);
		const unsubscribe = subscriber.subscribe((state) => {
			const seen = nOf(state);
			if (seen >= expected) {
				lastSeen = seen;
				clearTimeout(timer);
				unsubscribe();
				resolve(performance.now() - startedAt);
			}
		});
		writer
			.mutate({ args: {}, name: 'bump' })
			.catch((error: unknown) => {
				clearTimeout(timer);
				unsubscribe();
				reject(error);
			});
	});

const warmup = 25;
const count = 500;

for (let index = 0; index < warmup; index += 1) await propagate();

const latencies: number[] = [];
const start = performance.now();
for (let index = 0; index < count; index += 1) {
	latencies.push(await propagate());
}
const stats = computeStats(latencies, performance.now() - start);

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});
console.log(
	`# @absolutejs/sync — cluster propagation (writer→A, subscriber→B, PG-NOTIFY bus)\n`
);
console.log(`samples:          ${stats.count.toLocaleString('en-US')}`);
console.log(`propagation min:  ${round(stats.min, 3)} ms`);
console.log(`propagation p50:  ${round(stats.p50, 3)} ms`);
console.log(`propagation p95:  ${round(stats.p95, 3)} ms`);
console.log(`propagation p99:  ${round(stats.p99, 3)} ms`);
console.log(`propagation mean: ${round(stats.mean, 3)} ms`);
console.log(`propagation max:  ${round(stats.max, 3)} ms`);
console.log(
	`updates/sec:      ${Math.round(stats.throughput).toLocaleString('en-US')} (sequential)`
);
console.log('');
console.log(
	`row: | @absolutejs/sync | 2-engine cluster (PG-NOTIFY bus) | ${round(stats.min, 2)} | ${round(stats.p50, 2)} | ${round(stats.p95, 2)} | ${round(stats.p99, 2)} | ${round(stats.mean, 2)} |`
);

writer.close();
subscriber.close();
void appA.stop();
void appB.stop();
await sql.end();
await busSqlA.end();
await busSqlB.end();
process.exit(0);
