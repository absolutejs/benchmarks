/**
 * TanStack DB benchmark — the same shared-counter workload via TanStack DB's
 * queryCollection over a local Elysia REST server **backed by Postgres** (the
 * same DB the other benches hit). Measures collection.update → onUpdate POST →
 * server PG write → ack. Run: bun run scripts/bench-tanstack.ts
 */
import { Elysia } from 'elysia';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { QueryClient } from '@tanstack/query-core';
import { bumpCounter, readCounter, sql } from '../shared/counter-db';
import { measure, report } from './lib/measure';

const PORT = 4322;

type Counter = { id: string; n: number };

// Real-PG REST server.
const app = new Elysia()
	.get('/counter', async () => [{ id: 'c', n: await readCounter() }])
	.post('/counter/bump', async () => ({ id: 'c', n: await bumpCounter() }))
	.listen(PORT);

const queryClient = new QueryClient();

const counters = createCollection(
	queryCollectionOptions<Counter>({
		getKey: (item) => item.id,
		id: 'counters',
		queryClient,
		queryFn: async () =>
			fetch(`http://localhost:${PORT}/counter`).then((response) =>
				response.json()
			),
		queryKey: ['counters'],
		onUpdate: async () => {
			await fetch(`http://localhost:${PORT}/counter/bump`, {
				method: 'POST'
			});
		}
	})
);

await counters.preload();

const bump = async () => {
	const tx = counters.update('c', (draft) => {
		draft.n = (draft.n ?? 0) + 1;
	});
	await tx.isPersisted.promise;
};

const stats = await measure({ count: 500, warmup: 25, work: bump });
report('TanStack DB', 'local (REST + queryCollection) + PG-backed', stats);

void app.stop();
await sql.end();
process.exit(0);
