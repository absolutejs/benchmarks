/**
 * Zero benchmark — the same shared-counter workload against a local zero-cache
 * (its own Postgres, WS sync) with a separate push server running the custom
 * mutator authoritatively. Measures write round-trip latency + sequential
 * throughput.
 *
 * Setup (one terminal each):
 *   1. docker run … sync-bench-pg (see ZERO.md)
 *   2. bun run scripts/zero-push-server.ts
 *   3. ZERO_UPSTREAM_DB=… ZERO_PUSH_URL=http://localhost:5051/push … node ./node_modules/.bin/zero-cache
 *   4. bun run scripts/bench-zero.ts
 */
import { Zero } from '@rocicorp/zero';
import { schema } from '../zero/schema';
import { createMutators } from '../zero/mutators';
import { measure, measureConcurrent, report, reportConcurrent } from './lib/measure';

const sleep = (timeMs: number) =>
	new Promise((resolve) => setTimeout(resolve, timeMs));

const z = new Zero({
	auth: undefined,
	mutators: createMutators(),
	schema,
	server: 'http://localhost:4848',
	userID: `bench-${Math.random().toString(36).slice(2, 8)}`
});

// Let the WS handshake settle before measuring.
await sleep(500);

const bump = async () => {
	const pending = z.mutate.counter.bump({});
	const promise = (pending as unknown as { server?: Promise<unknown> }).server;
	if (promise !== undefined) {
		await promise;
	} else {
		await pending;
	}
};

const stats = await measure({ count: 500, warmup: 25, work: bump });
report('Zero', 'local (zero-cache + push server + PG)', stats);

console.log('\n## Concurrent (pipelined) throughput\n');
for (const concurrency of [4, 16, 64]) {
	const cStats = await measureConcurrent({
		concurrency,
		total: 500,
		warmup: 25,
		work: bump
	});
	reportConcurrent('Zero', concurrency, cStats);
}

z.close();
process.exit(0);
