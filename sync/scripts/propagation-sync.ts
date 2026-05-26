/**
 * @absolutejs/sync propagation-latency benchmark.
 *
 * The write-roundtrip bench (`bench-sync.ts`) measures "writer issues mutation
 * → server acks". This one measures the **qualitative** thing live-query engines
 * exist for: "writer mutates → a SEPARATE subscriber sees the new value".
 *
 * Setup: two clients against the same engine. Subscriber subscribes to the
 * `counter` collection; writer bumps; timer stops when the subscriber's state
 * carries the new `n`. Per-iteration latency = ack roundtrip + server fan-out
 * + WS-frame to the subscriber.
 *
 * Run: bun run scripts/propagation-sync.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import { bumpCounter, readCounter, sql } from '../shared/counter-db';
import { computeStats } from './lib/measure';

const PORT = 4329;

type Row = { id: string; n: number };

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

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);
const sleep = (timeMs: number) =>
	new Promise((resolve) => setTimeout(resolve, timeMs));
const url = `ws://localhost:${PORT}/sync/ws`;

// Two independent clients against the same engine — one writes, one watches.
const writer = createSyncCollection<Row>({ collection: 'counter', url });
const subscriber = createSyncCollection<Row>({ collection: 'counter', url });

for (let attempt = 0; attempt < 100; attempt += 1) {
	if (
		writer.get().status === 'ready' &&
		subscriber.get().status === 'ready'
	) {
		break;
	}
	await sleep(50);
}
// Fail-fast if the polling above never reached `ready` — better to abort than
// produce a "bench ran but measured nothing useful" result.
if (
	writer.get().status !== 'ready' ||
	subscriber.get().status !== 'ready'
) {
	throw new Error(
		`sync clients never became ready (writer=${writer.get().status}, subscriber=${subscriber.get().status})`
	);
}

const nOf = (state: ReturnType<typeof subscriber.get>): number => {
	const row = state.data[0];

	return typeof row?.n === 'number' ? row.n : -1;
};

let lastSeen = nOf(subscriber.get());
// Per-iteration safety net — if a subscriber update never arrives (network
// stall, server bug, dropped frame) we'd rather see a loud failure than a
// silently-hung run. 10 s is comfortably above the p99s we measure.
const ITERATION_TIMEOUT_MS = 10_000;

/** Issue one bump from the writer and wait until the subscriber observes it. */
const propagate = (): Promise<number> =>
	new Promise<number>((resolve, reject) => {
		const startedAt = performance.now();
		const expected = lastSeen + 1;
		const timer = setTimeout(() => {
			unsubscribe();
			reject(
				new Error(
					`sync propagation iteration timed out after ${ITERATION_TIMEOUT_MS} ms (expected n=${expected}, last seen=${lastSeen})`
				)
			);
		}, ITERATION_TIMEOUT_MS);
		// Wire the subscriber watcher BEFORE issuing the write so we never miss
		// a fast fan-out that lands between mutate() and subscribe().
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
const totalMs = performance.now() - start;
const stats = computeStats(latencies, totalMs);

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});
console.log(`# @absolutejs/sync — write → remote-subscriber-receive\n`);
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
	`row: | @absolutejs/sync | local (WS) + PG | ${round(stats.min, 2)} | ${round(stats.p50, 2)} | ${round(stats.p95, 2)} | ${round(stats.p99, 2)} | ${round(stats.mean, 2)} |`
);

writer.close();
subscriber.close();
void app.stop();
await sql.end();
process.exit(0);
