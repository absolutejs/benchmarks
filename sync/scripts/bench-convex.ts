/**
 * Convex benchmark — the same shared-counter workload against a Convex cloud
 * deployment. Convex runs in its cloud, so the numbers include public-internet
 * round-trip latency (see ../RESULTS.md conditions).
 *
 * Setup: see ../CONVEX.md. Run: CONVEX_URL=https://<dep>.convex.cloud bun run scripts/bench-convex.ts
 */
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { measure, report } from './lib/measure';

const url = process.env.CONVEX_URL;
if (url === undefined || url.length === 0) {
	throw new Error('Set CONVEX_URL to your deployment URL');
}

const client = new ConvexClient(url);
const stats = await measure({
	count: 500,
	warmup: 25,
	work: () => client.mutation(api.counter.bump, {})
});

report('Convex', 'cloud — US East (HTTPS)', stats);

await client.close();
process.exit(0);
