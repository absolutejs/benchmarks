/**
 * @absolutejs/sync benchmark — a local Elysia + syncSocket server holding a
 * shared counter, and a sync client that issues increments over a real loopback
 * WebSocket. Measures write round-trip latency (mutate → server ack) and
 * sequential throughput. Run: bun run scripts/bench-sync.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import { measure, report } from './lib/measure';

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

for (let attempt = 0; attempt < 100; attempt += 1) {
	if (collection.get().status === 'ready') {
		break;
	}
	await sleep(50);
}

const stats = await measure({
	count: 2_000,
	warmup: 100,
	work: () => collection.mutate({ args: {}, name: 'bump' })
});

report('@absolutejs/sync', 'local (WebSocket, loopback)', stats);

collection.close();
void app.stop();
process.exit(0);
