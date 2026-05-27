/**
 * Reactive-read bench #6b — wire bytes per single-row mutation, Convex side.
 *
 * Companion to `wire-bytes-sync.ts`. Convex's wire protocol pushes the whole
 * new query result per change (per their GitHub issue #95 + the "object
 * sync engine" roadmap). We monkey-patch `globalThis.WebSocket` with a
 * counting wrapper BEFORE constructing `ConvexClient`, so the bytes the
 * client receives are counted directly.
 *
 * Run: CONVEX_URL=http://127.0.0.1:3210 bun run scripts/reactive/wire-bytes-convex.ts
 */
import { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

const url = process.env.CONVEX_URL;
if (url === undefined || url.length === 0) {
	throw new Error('Set CONVEX_URL');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

const RealWebSocket = globalThis.WebSocket;

// Per-iteration byte counters (reset between measurements).
let bytesIn = 0;
let bytesOut = 0;

class CountingWebSocket extends RealWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		super(url, protocols);
		const origSend = this.send.bind(this);
		this.send = (data) => {
			if (typeof data === 'string') {
				bytesOut += Buffer.byteLength(data, 'utf8');
			} else if (data instanceof ArrayBuffer) {
				bytesOut += data.byteLength;
			}
			origSend(data);
		};
		this.addEventListener('message', (event) => {
			const data = (event as MessageEvent).data;
			if (typeof data === 'string') {
				bytesIn += Buffer.byteLength(data, 'utf8');
			} else if (data instanceof ArrayBuffer) {
				bytesIn += data.byteLength;
			}
		});
	}
}
globalThis.WebSocket = CountingWebSocket as unknown as typeof WebSocket;

const PAGE = 1000;

const purgeAll = async (client: ConvexClient): Promise<void> => {
	// Convex limits a single function to 4096 reads / 16000 writes — we have
	// to purge in pages.
	for (;;) {
		const deleted = (await client.mutation(api.rtasks.purgePage, {})) as number;
		if (deleted === 0) break;
	}
};
const seedTasks = async (client: ConvexClient, count: number): Promise<void> => {
	for (let from = 0; from < count; from += PAGE) {
		const to = Math.min(from + PAGE, count);
		await client.mutation(api.rtasks.seedRange, { from, to });
	}
};

const measureAtSize = async (K: number) => {
	const client = new ConvexClient(url);
	await purgeAll(client);
	await seedTasks(client, K);

	// Subscribe to the list query so we receive the initial result + every
	// subsequent update.
	let received = 0;
	let lastLen = -1;
	const unsubscribe = client.onUpdate(
		api.rtasks.list,
		{},
		(rows) => {
			received += 1;
			const len = Array.isArray(rows) ? rows.length : 0;
			lastLen = len;
		}
	);

	// Wait for the initial result.
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (received > 0) break;
		await sleep(25);
	}
	if (received === 0) {
		throw new Error(`initial list result never arrived for K=${K}`);
	}
	// Settle anything in-flight.
	await sleep(200);

	// Reset counters — measure ONLY the per-mutation diffs.
	bytesIn = 0;
	bytesOut = 0;
	const beforeReceived = received;

	const iterations = 25;
	for (let index = 0; index < iterations; index += 1) {
		await client.mutation(api.rtasks.bumpFirst, {});
		// Wait until this iteration's update has landed on the subscriber
		// before firing the next, so each iteration's bytes are accounted to
		// it.
		const targetReceived = beforeReceived + index + 1;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (received >= targetReceived) break;
			await sleep(5);
		}
	}

	const totalIn = bytesIn;
	const perWrite = totalIn / iterations;

	unsubscribe();
	await client.close();
	await sleep(200);

	return { K, lastLen, perWrite, totalIn };
};

const results: Array<{ K: number; totalIn: number; perWrite: number }> = [];
// Convex caps array return values at 8192 entries — we bench up to 5000 to
// stay safely under. Sync has no such limit (caps are PG-bound, which is
// effectively unbounded for these sizes).
for (const K of [100, 1_000, 5_000]) {
	console.log(`# K=${K.toLocaleString('en-US')} rows held by subscriber…`);
	const out = await measureAtSize(K);
	console.log(
		`  total inbound over 25 writes: ${out.totalIn.toLocaleString('en-US')} bytes`
	);
	console.log(
		`  per-write inbound (full-result frame): ${round(out.perWrite, 0)} bytes`
	);
	results.push({ K, perWrite: out.perWrite, totalIn: out.totalIn });
}

console.log(
	'\n## Wire bytes per single-row mutation (Convex full-result frame)\n'
);
console.log('| K rows held | bytes/write (subscriber inbound) |');
console.log('|---|---|');
for (const row of results) {
	console.log(
		`| ${row.K.toLocaleString('en-US')} | ${Math.round(row.perWrite).toLocaleString('en-US')} |`
	);
}

process.exit(0);
