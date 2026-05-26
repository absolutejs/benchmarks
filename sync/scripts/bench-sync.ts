/**
 * @absolutejs/sync benchmark — a local Elysia + syncSocket server holding a
 * shared counter, and a sync client that issues increments over a real loopback
 * WebSocket. Measures write round-trip latency (mutate → server ack) and
 * sustained throughput. Run: bun run scripts/bench-sync.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';

const PORT = 4319;

type Row = { id: string; n: number };

const rows = new Map<string, Row>([['c', { id: 'c', n: 0 }]]);
const engine = createSyncEngine();
engine.registerReader('counter', { all: () => [...rows.values()] });
engine.registerWriter<Row>('counter', {
	delete: () => {},
	insert: (row) => {
		rows.set(row.id, row);
		return row;
	},
	update: (row) => {
		rows.set(row.id, row);
		return row;
	}
});
engine.registerReactive(
	defineReactiveQuery<Row>({
		key: (row) => row.id,
		name: 'counter',
		run: ({ db }) => db.all<Row>('counter')
	})
);
engine.registerMutation(
	defineMutation({
		handler: (_args, _ctx, actions) =>
			actions.update<Row>('counter', {
				id: 'c',
				n: (rows.get('c')?.n ?? 0) + 1
			}),
		name: 'bump'
	})
);

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);

const sleep = (timeMs: number) =>
	new Promise((resolve) => setTimeout(resolve, timeMs));

const url = `ws://localhost:${PORT}/sync/ws`;
const collection = createSyncCollection<Row>({ collection: 'counter', url });

// Wait for the socket to be live.
for (let attempt = 0; attempt < 100; attempt += 1) {
	if (collection.get().status === 'ready') {
		break;
	}
	await sleep(50);
}

const bump = () =>
	collection.mutate({ args: {}, name: 'bump' });

console.error(`[bench] status=${collection.get().status}, warming up…`);
// Warm up (JIT + connection).
for (let index = 0; index < 100; index += 1) {
	await bump();
}
console.error('[bench] warmup done, measuring…');

// Measure sequential write round-trip.
const count = 2_000;
const latencies: number[] = [];
const start = performance.now();
for (let index = 0; index < count; index += 1) {
	const at = performance.now();
	await bump();
	latencies.push(performance.now() - at);
	if ((index + 1) % 500 === 0) {
		console.error(`[bench] ${index + 1}/${count}`);
	}
}
const totalMs = performance.now() - start;

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.floor((latencies.length - 1) * p)]!;
const mean = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

console.log('# @absolutejs/sync — shared counter (local loopback WebSocket)\n');
console.log(`writes:            ${count.toLocaleString('en-US')}`);
console.log(`round-trip p50:    ${pct(0.5).toFixed(3)} ms`);
console.log(`round-trip p95:    ${pct(0.95).toFixed(3)} ms`);
console.log(`round-trip mean:   ${mean.toFixed(3)} ms`);
console.log(
	`throughput:        ${Math.round(count / (totalMs / 1000)).toLocaleString('en-US')} writes/sec (sequential)`
);

collection.close();
void app.stop();
process.exit(0);
