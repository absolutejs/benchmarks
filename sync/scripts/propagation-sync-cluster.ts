/**
 * @absolutejs/sync propagation latency across a CLUSTER BUS.
 *
 * The `propagation-sync.ts` bench measures fan-out inside a single engine
 * process. This one measures the cross-instance path: TWO engines in the same
 * Bun process, connected by the in-memory cluster bus, the writer's mutation
 * lands on engine A and the subscriber lives on engine B.
 *
 * In-memory bus is the floor (no serialisation, no IPC, no network) — it tells
 * us the engine's intrinsic cross-instance overhead on top of write-ack and
 * single-instance fan-out (sync.ts measured ~11 ms p50 single-instance). A
 * real Redis/PG-NOTIFY bus would add more; that's a follow-up.
 *
 * Run: bun run scripts/propagation-sync-cluster.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createInMemoryClusterBus,
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import { bumpCounter, readCounter, sql } from '../shared/counter-db';
import { computeStats } from './lib/measure';

const PORT_A = 4339;
const PORT_B = 4340;

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

const bus = createInMemoryClusterBus();
const engineA = makeEngine();
const engineB = makeEngine();
await engineA.connectCluster(bus);
await engineB.connectCluster(bus);

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

// The subscriber's initial reactive snapshot comes from engine B's own reader,
// which runs against the shared Postgres — so it sees the current counter
// value, not 0. We seed `lastSeen` from that snapshot so we measure deltas.
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
					`sync cluster propagation iteration timed out after ${ITERATION_TIMEOUT_MS} ms (expected n=${expected}, last seen=${lastSeen})`
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
	`# @absolutejs/sync — cluster propagation (writer→A, subscriber→B, in-memory bus)\n`
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
	`row: | @absolutejs/sync | 2-engine cluster (in-memory bus) | ${round(stats.min, 2)} | ${round(stats.p50, 2)} | ${round(stats.p95, 2)} | ${round(stats.p99, 2)} | ${round(stats.mean, 2)} |`
);

writer.close();
subscriber.close();
void appA.stop();
void appB.stop();
await sql.end();
process.exit(0);
