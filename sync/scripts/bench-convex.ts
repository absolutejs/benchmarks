/**
 * Convex benchmark — the same shared-counter workload against a Convex cloud
 * deployment. Measures write round-trip latency (mutation → confirmed) and
 * sequential throughput. NOTE: Convex runs in its cloud, so these numbers
 * include public-internet round-trip latency (see ../README.md conditions).
 *
 * Setup: see ../CONVEX.md. Run: CONVEX_URL=https://<dep>.convex.cloud bun run scripts/bench-convex.ts
 */
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';

const url = process.env.CONVEX_URL;
if (url === undefined || url.length === 0) {
	throw new Error(
		'Set CONVEX_URL to your deployment URL (e.g. https://xyz.convex.cloud)'
	);
}

const client = new ConvexClient(url);
const bump = () => client.mutation(api.counter.bump, {});

// Warm up.
for (let index = 0; index < 50; index += 1) {
	await bump();
}

const count = 500;
const latencies: number[] = [];
const start = performance.now();
for (let index = 0; index < count; index += 1) {
	const at = performance.now();
	await bump();
	latencies.push(performance.now() - at);
}
const totalMs = performance.now() - start;

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.floor((latencies.length - 1) * p)]!;
const mean = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

console.log('# Convex — shared counter (cloud deployment, network round-trip)\n');
console.log(`writes:            ${count.toLocaleString('en-US')}`);
console.log(`round-trip p50:    ${pct(0.5).toFixed(3)} ms`);
console.log(`round-trip p95:    ${pct(0.95).toFixed(3)} ms`);
console.log(`round-trip mean:   ${mean.toFixed(3)} ms`);
console.log(
	`throughput:        ${Math.round(count / (totalMs / 1000)).toLocaleString('en-US')} writes/sec (sequential)`
);

await client.close();
process.exit(0);
