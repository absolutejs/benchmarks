/**
 * TanStack DB benchmark — the same shared-counter workload via TanStack DB's
 * queryCollection over a local Elysia REST server. Measures write round-trip
 * latency (collection.update → onUpdate POST → server ack) and sequential
 * throughput. TanStack DB is a client store + sync coordinator (not itself a
 * sync engine), so this measures: TanStack DB's transaction overhead + an HTTP
 * round-trip to a local REST backend. Run: bun run scripts/bench-tanstack.ts
 */
import { Elysia } from 'elysia';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { QueryClient } from '@tanstack/query-core';
import { measure, report } from './lib/measure';

const PORT = 4322;

type Counter = { id: string; n: number };
let counter: Counter = { id: 'c', n: 0 };

// A minimal authoritative REST server for the counter.
const app = new Elysia()
	.get('/counter', () => [counter])
	.post('/counter/bump', () => {
		counter = { ...counter, n: counter.n + 1 };
		return counter;
	})
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
			// One POST per write — the server-authoritative half of the round-trip.
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
	// Wait for the mutation to be persisted (onUpdate POST completes).
	await tx.isPersisted.promise;
};

const stats = await measure({ count: 500, warmup: 50, work: bump });
report('TanStack DB', 'local (REST over Elysia, queryCollection)', stats);

void app.stop();
process.exit(0);
