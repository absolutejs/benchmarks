/**
 * Zero benchmark — the same shared-counter workload against a local zero-cache
 * (the closest architectural rival to @absolutejs/sync: both run on your own
 * Postgres, both push diffs over a WebSocket). Measures write round-trip
 * latency (mutation → server ack) and sequential throughput.
 *
 * Setup: see ../ZERO.md. Run: bun run scripts/bench-zero.ts
 */
import { Zero } from '@rocicorp/zero';
import { schema } from '../zero/schema';
import { measure, report } from './lib/measure';

const sleep = (timeMs: number) =>
	new Promise((resolve) => setTimeout(resolve, timeMs));

const z = new Zero({
	auth: undefined,
	schema,
	server: 'http://localhost:4848',
	userID: `bench-${Math.random().toString(36).slice(2, 8)}`
});

// Materialize the counter row + wait for the first hydrate.
const view = z.query.counters.where('id', '=', 'c').materialize();
for (let attempt = 0; attempt < 100; attempt += 1) {
	if (view.data.length > 0) {
		break;
	}
	await sleep(50);
}

const bump = async () => {
	const current = view.data[0];
	const n = Number(current?.n ?? 0) + 1;
	// In Zero v1.x, the mutate call returns a `{ client, server }` pair; awaiting
	// `.server` measures server-acked round-trip (not just optimistic apply).
	const pending = z.mutate.counters.update({ id: 'c', n });
	const promise = (pending as unknown as { server?: Promise<unknown> }).server;
	if (promise !== undefined) {
		await promise;
	} else {
		await pending;
	}
};

const stats = await measure({ count: 500, warmup: 25, work: bump });
report('Zero', 'local (zero-cache + Postgres, WS)', stats);

z.close();
process.exit(0);
