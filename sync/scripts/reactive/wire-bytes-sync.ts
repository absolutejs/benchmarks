/**
 * Reactive-read bench #6 — wire bytes per single-row mutation.
 *
 * The sync engine sends `diff` frames with `{ added, removed, changed }`
 * arrays — only the rows that actually changed. Per Convex's own GitHub
 * issue #95 + their "object sync engine" roadmap, Convex still pushes the
 * whole new query result on every change. The bandwidth gap should scale
 * with K (rows held by the subscriber).
 *
 * Methodology: subscribe to `rtasks` (K rows pre-seeded), wrap the WS with
 * a byte-counter, fire 25 mutations that each bump ONE row's priority, sum
 * subscriber-inbound bytes per write.
 *
 * Run: bun run scripts/reactive/wire-bytes-sync.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import { ensureSchema, sql } from './tasks-db';
import { waitReady } from './lib';

const PORT = 4360;

type Row = {
	id: string;
	title: string;
	priority: number;
};

await ensureSchema();

const engine = createSyncEngine();
engine.registerReader('rtasks', {
	all: async () => {
		const rows = await sql<
			Array<{ id: string; title: string; priority: number }>
		>`select id, title, priority from rtasks`;

		return rows as Row[];
	}
});
engine.registerWriter<Row>('rtasks', {
	delete: () => {},
	insert: () => ({ id: '', priority: 0, title: '' }),
	update: async (row: { id: string }) => {
		const rows = await sql<
			Array<{ id: string; title: string; priority: number }>
		>`update rtasks set priority = priority + 1 where id = ${row.id}
		  returning id, title, priority`;

		return (rows[0] ?? { id: row.id, priority: 0, title: '' }) as Row;
	}
});
engine.registerReactive(
	defineReactiveQuery<Row>({
		key: (row) => row.id,
		name: 'rtasks',
		run: ({ db }) => db.all<Row>('rtasks')
	})
);
engine.registerMutation(
	defineMutation({
		handler: (args: { id: string }, _ctx, actions) =>
			actions.update<Row>('rtasks', { id: args.id }),
		name: 'bumpRow'
	})
);

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = `ws://localhost:${PORT}/sync/ws`;

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

/**
 * Counting WebSocket: wraps a real WS, sums inbound + outbound bytes per
 * frame. We pass it to createSyncCollection via webSocketImpl so the
 * subscriber's actual wire traffic is measured (not just protocol-shape
 * estimates).
 */
class CountingSocket {
	url: string;
	private inner: WebSocket;
	bytesIn = 0;
	bytesOut = 0;
	onopen: (ev: Event) => unknown = () => {};
	onmessage: (ev: MessageEvent) => unknown = () => {};
	onclose: (ev: CloseEvent) => unknown = () => {};
	onerror: (ev: Event) => unknown = () => {};

	constructor(url: string) {
		this.url = url;
		this.inner = new WebSocket(url);
		this.inner.onopen = (ev) => this.onopen(ev);
		this.inner.onmessage = (ev: MessageEvent) => {
			const data = ev.data as string | ArrayBuffer | Blob;
			if (typeof data === 'string') {
				this.bytesIn += Buffer.byteLength(data, 'utf8');
			} else if (data instanceof ArrayBuffer) {
				this.bytesIn += data.byteLength;
			}
			this.onmessage(ev);
		};
		this.inner.onclose = (ev) => this.onclose(ev);
		this.inner.onerror = (ev) => this.onerror(ev);
	}
	send(data: string | ArrayBufferLike | ArrayBufferView) {
		if (typeof data === 'string') {
			this.bytesOut += Buffer.byteLength(data, 'utf8');
		} else if (data instanceof ArrayBuffer) {
			this.bytesOut += data.byteLength;
		}
		this.inner.send(data as never);
	}
	close(code?: number, reason?: string) {
		this.inner.close(code, reason);
	}
	get readyState() {
		return this.inner.readyState;
	}
}

const seedRtasks = async (count: number): Promise<void> => {
	await sql`truncate rtasks`;
	if (count === 0) return;
	const batch = 1000;
	for (let start = 0; start < count; start += batch) {
		const rows: Array<{
			id: string;
			title: string;
			assignee: string;
			priority: number;
			done: boolean;
			created_at: number;
		}> = [];
		const end = Math.min(start + batch, count);
		for (let index = start; index < end; index += 1) {
			rows.push({
				assignee: 'alex',
				created_at: index,
				done: false,
				id: `wt-${index}`,
				priority: index,
				title: `Task ${index}`
			});
		}
		await sql`insert into rtasks ${sql(rows)}`;
	}
};

const firstId = (): Promise<string> =>
	sql<Array<{ id: string }>>`select id from rtasks order by id limit 1`.then(
		(rows) => rows[0]?.id ?? ''
	);

const measureAtSize = async (K: number) => {
	await seedRtasks(K);
	await sleep(150);

	// Construct the subscriber WITH our counting WS impl so we see actual
	// inbound bytes (snapshot frame + per-mutation diff frames).
	let countingRef: CountingSocket | undefined;
	const Impl = class extends CountingSocket {
		constructor(u: string) {
			super(u);
			countingRef = this;
		}
	} as unknown as typeof WebSocket;

	const subscriber = createSyncCollection<Row>({
		collection: 'rtasks',
		url,
		webSocketImpl: Impl
	});
	const writer = createSyncCollection<Row>({ collection: 'rtasks', url });
	await waitReady([
		{ get: () => subscriber.get().status, label: 'subscriber' },
		{ get: () => writer.get().status, label: 'writer' }
	]);
	// Settle the initial snapshot frame before we start counting per-mutation.
	await sleep(150);

	const id = await firstId();
	if (!id) throw new Error('no rows to bump');

	// Reset the in counter so we measure ONLY the per-mutation diff frames,
	// not the initial snapshot (which dominates if K is large).
	if (countingRef !== undefined) countingRef.bytesIn = 0;

	const iterations = 25;
	for (let index = 0; index < iterations; index += 1) {
		const before =
			subscriber.get().data.find((row) => row.id === id)?.priority ?? 0;
		await writer.mutate({ args: { id }, name: 'bumpRow' });
		// `syncCollection.subscribe` doesn't fire its listener with the
		// current state on registration (unlike `syncClient.subscribe`).
		// If the diff has ALREADY landed by the time we subscribe, the
		// listener never fires. Cheapest fix for a bench: poll the state
		// for the new priority. The wire bytes have been counted by the
		// CountingWS irrespective of when we read.
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const current =
				subscriber.get().data.find((row) => row.id === id)?.priority ?? 0;
			if (current > before) break;
			await sleep(5);
		}
	}

	const totalIn = countingRef?.bytesIn ?? 0;
	const perWrite = totalIn / iterations;

	subscriber.close();
	writer.close();
	await sleep(100);

	return { totalIn, perWrite };
};

const results: Array<{ K: number; totalIn: number; perWrite: number }> = [];
// Convex caps array return values at 8192 entries (their `Limits` doc) — so
// the comparison bench caps at 5000 to stay under. Sync has no equivalent
// limit, but we use the matching K values to keep the head-to-head clean.
for (const K of [100, 1_000, 5_000]) {
	console.log(`# K=${K.toLocaleString('en-US')} rows held by subscriber…`);
	const out = await measureAtSize(K);
	console.log(
		`  total inbound over ${25} writes: ${out.totalIn.toLocaleString('en-US')} bytes`
	);
	console.log(
		`  per-write inbound (diff frame): ${round(out.perWrite, 0)} bytes`
	);
	results.push({ K, perWrite: out.perWrite, totalIn: out.totalIn });
}

console.log(
	'\n## Wire bytes per single-row mutation (sync diff frame)\n'
);
console.log('| K rows held | bytes/write (subscriber inbound) |');
console.log('|---|---|');
for (const row of results) {
	console.log(
		`| ${row.K.toLocaleString('en-US')} | ${Math.round(row.perWrite).toLocaleString('en-US')} |`
	);
}

void app.stop();
await sql.end();
process.exit(0);
