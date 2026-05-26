/**
 * @absolutejs/sync benchmark — Elysia + syncSocket holding a shared counter
 * **backed by Postgres** (real fsync per write), accessed over loopback WS.
 * Measures write round-trip latency + sequential throughput against the same
 * authoritative store every other backend in this folder hits.
 * Run: bun run scripts/bench-sync.ts
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
import { measure, measureConcurrent, report, reportConcurrent } from './lib/measure';

const PORT = 4319;

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
const collection = createSyncCollection<Row>({ collection: 'counter', url });

for (let attempt = 0; attempt < 100; attempt += 1) {
	if (collection.get().status === 'ready') {
		break;
	}
	await sleep(50);
}

const stats = await measure({
	count: 1_000,
	warmup: 50,
	work: () => collection.mutate({ args: {}, name: 'bump' })
});

report('@absolutejs/sync', 'local (WS) + PG-backed', stats);

console.log('\n## Concurrent (pipelined) throughput\n');
for (const concurrency of [4, 16, 64]) {
	const cStats = await measureConcurrent({
		concurrency,
		total: 1_000,
		warmup: 50,
		work: () => collection.mutate({ args: {}, name: 'bump' })
	});
	reportConcurrent('@absolutejs/sync', concurrency, cStats);
}

collection.close();
void app.stop();
await sql.end();
process.exit(0);
