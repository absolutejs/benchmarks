/**
 * Convex propagation-latency benchmark — write → remote-subscriber-receive.
 *
 * Two `ConvexClient` instances point at the same cloud deployment: the
 * subscriber registers `onUpdate` for `counter.get`, the writer issues bumps.
 * Latency per iteration = time from issuing the mutation to the subscriber's
 * callback firing with the new value. Convex's reactive-query model pushes the
 * recomputed result over WebSocket, so this measures the actual user-visible
 * "another tab sees the change" delay end-to-end.
 *
 * Run: CONVEX_URL=https://<dep>.convex.cloud bun run scripts/propagation-convex.ts
 */
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { computeStats } from './lib/measure';

const url = process.env.CONVEX_URL;
if (url === undefined || url.length === 0) {
	throw new Error('Set CONVEX_URL to your deployment URL');
}

const sleep = (timeMs: number) =>
	new Promise((resolve) => setTimeout(resolve, timeMs));

const writer = new ConvexClient(url);
const subscriber = new ConvexClient(url);

let latest = 0;
type Pending = {
	expected: number;
	resolve: (latency: number) => void;
	timer: ReturnType<typeof setTimeout>;
};
let pending: Pending | null = null;
let startedAt = 0;

const unsubscribe = subscriber.onUpdate(api.counter.get, {}, (value) => {
	const n = typeof value === 'number' ? value : 0;
	latest = n;
	if (pending !== null && n >= pending.expected) {
		const { resolve, timer } = pending;
		pending = null;
		clearTimeout(timer);
		resolve(performance.now() - startedAt);
	}
});

// Let the initial subscription settle so we know `latest` is the real value.
await sleep(800);

// Per-iteration safety net — a hung subscriber push should fail loudly, not
// stall the bench forever. 15 s is well above Convex's measured p99 over WAN.
const ITERATION_TIMEOUT_MS = 15_000;

const propagate = (): Promise<number> =>
	new Promise<number>((resolve, reject) => {
		const expected = latest + 1;
		startedAt = performance.now();
		const timer = setTimeout(() => {
			pending = null;
			reject(
				new Error(
					`Convex propagation iteration timed out after ${ITERATION_TIMEOUT_MS} ms (expected n=${expected}, last seen=${latest})`
				)
			);
		}, ITERATION_TIMEOUT_MS);
		pending = { expected, resolve, timer };
		writer.mutation(api.counter.bump, {}).catch((error: unknown) => {
			pending = null;
			clearTimeout(timer);
			reject(error);
		});
	});

// Match bench-convex.ts's warmup/count (cloud round-trip is ~70 ms, so larger
// counts pay quickly; staying consistent with the existing convention keeps
// percentiles directly comparable).
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
console.log(`# Convex — write → remote-subscriber-receive (cloud, HTTPS)\n`);
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
	`row: | Convex | cloud (HTTPS) | ${round(stats.min, 2)} | ${round(stats.p50, 2)} | ${round(stats.p95, 2)} | ${round(stats.p99, 2)} | ${round(stats.mean, 2)} |`
);

unsubscribe();
await writer.close();
await subscriber.close();
process.exit(0);
