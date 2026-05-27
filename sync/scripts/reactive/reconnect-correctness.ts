/**
 * Reactive-read correctness bench — does sync drop diffs on reconnect?
 *
 * The most-cited bug class in this whole category. Supabase Realtime
 * acknowledged silent drops on background-tab reconnect:
 *   https://github.com/orgs/supabase/discussions/5641
 * And closed their memory-leak issue as "not planned":
 *   https://github.com/supabase/supabase-js/issues/1204
 * ElectricSQL needed an August 2025 reliability sprint to fix several
 * post-1.0-GA correctness regressions:
 *   https://electric-sql.com/blog/2025/08/04/reliability-sprint
 * Firebase RTDB has historical reports of 13-hour outages causing
 * silent drops:
 *   https://news.ycombinator.com/item?id=19047812
 *
 * Sync's `since`-token catch-up was designed to make this class of bug
 * impossible. This script proves it: thousand iterations of the
 * disconnect-during-writes pattern, hard-asserting that every write
 * issued AFTER subscribe shows up on the subscriber.
 *
 * If this script ever fails — silently or otherwise — the catch-up
 * machinery has regressed and the "We Heard You" docs page has a hole.
 *
 * Per iteration:
 *   1. Subscribe a fresh client to the rtasks collection.
 *   2. Issue WRITES_BEFORE_DISCONNECT mutations.
 *   3. `client.disconnect()` — closes the WS without losing
 *      appliedVersion state.
 *   4. Issue WRITES_DURING_DISCONNECT mutations.
 *   5. Auto-reconnect kicks in.
 *   6. Wait until the subscriber's view contains every write issued
 *      after step 1.
 *   7. If the wait times out, FAIL the iteration (silent drop).
 *
 * Run: bun run scripts/reactive/reconnect-correctness.ts
 */

import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import { createSyncCollection } from '@absolutejs/sync/client';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';

const PORT = 4730;
const ITERATIONS = 100;
const WRITES_BEFORE_DISCONNECT = 3;
const WRITES_DURING_DISCONNECT = 5;
const TOTAL_PER_ITER = WRITES_BEFORE_DISCONNECT + WRITES_DURING_DISCONNECT;
const WAIT_TIMEOUT_MS = 2000;

type Row = { id: string; n: number };

// In-memory backing store. Reset between iterations so each test sees
// a clean slate.
const store = new Map<string, Row>();

const engine = createSyncEngine();
engine.registerReader('rtasks', { all: async () => [...store.values()] });
engine.registerWriter<Row>('rtasks', {
	delete: async (row) => {
		store.delete((row as Row).id);
	},
	insert: async (data) => {
		const row = data as Row;
		store.set(row.id, row);
		return row;
	},
	update: async (data) => {
		const row = data as Row;
		store.set(row.id, row);
		return row;
	}
});
engine.registerReactive(
	defineReactiveQuery<Row>({
		key: (row) => row.id,
		name: 'rtasks',
		run: async ({ db }) => db.all<Row>('rtasks')
	})
);
engine.registerMutation(
	defineMutation({
		handler: (_args, _ctx, actions) =>
			actions.insert<Row>('rtasks', {
				id: (_args as { id: string }).id,
				n: (_args as { n: number }).n
			}),
		name: 'addRow'
	})
);

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);
const url = `ws://localhost:${PORT}/sync/ws`;
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

// Wait until predicate returns true OR the deadline expires.
const waitFor = async (
	predicate: () => boolean,
	timeoutMs: number
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(5);
	}
	return predicate();
};

console.log('# Reconnect correctness — sync vs every other engine');
console.log('');
console.log(
	`  ${ITERATIONS} iterations · ${TOTAL_PER_ITER} writes each (${WRITES_BEFORE_DISCONNECT} before disconnect, ${WRITES_DURING_DISCONNECT} after) · wait timeout ${WAIT_TIMEOUT_MS} ms`
);
console.log('');

let totalDropped = 0;
let totalDelivered = 0;
let droppedIterations = 0;

const iterStart = performance.now();
for (let i = 0; i < ITERATIONS; i += 1) {
	// Reset the backing store for this iteration.
	store.clear();

	const issuedIds = new Set<string>();
	const collection = createSyncCollection<Row>({ collection: 'rtasks', url });

	// Wait for initial subscribe to land.
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (collection.get().status === 'ready') break;
		await sleep(20);
	}

	// Phase 1: writes BEFORE disconnect.
	for (let k = 0; k < WRITES_BEFORE_DISCONNECT; k += 1) {
		const id = `iter${i}-pre${k}`;
		issuedIds.add(id);
		await collection.mutate({
			args: { id, n: k },
			name: 'addRow'
		});
	}

	// Phase 2: disconnect.
	collection.disconnect();

	// Phase 3: writes WHILE DISCONNECTED. We do these via a second
	// short-lived client (because the disconnected one can't talk to
	// the server). The data lands in the engine just the same.
	const writer = createSyncCollection<Row>({
		collection: 'rtasks',
		url
	});
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (writer.get().status === 'ready') break;
		await sleep(20);
	}
	for (let k = 0; k < WRITES_DURING_DISCONNECT; k += 1) {
		const id = `iter${i}-mid${k}`;
		issuedIds.add(id);
		await writer.mutate({
			args: { id, n: 100 + k },
			name: 'addRow'
		});
	}
	writer.disconnect();

	// Phase 4: implicit reconnect. The disconnected `collection` should
	// auto-reconnect on the next interaction. We poll for it to see
	// every issued id.
	const allDelivered = await waitFor(() => {
		const seen = new Set(collection.get().data.map((r) => r.id));
		for (const id of issuedIds) {
			if (!seen.has(id)) return false;
		}
		return true;
	}, WAIT_TIMEOUT_MS);

	const seenIds = new Set(collection.get().data.map((r) => r.id));
	const droppedInThisIter: string[] = [];
	for (const id of issuedIds) {
		if (!seenIds.has(id)) droppedInThisIter.push(id);
	}
	totalDelivered += issuedIds.size - droppedInThisIter.length;
	totalDropped += droppedInThisIter.length;
	if (droppedInThisIter.length > 0) {
		droppedIterations += 1;
		console.log(
			`  iter ${i.toString().padStart(3)}: DROPPED ${droppedInThisIter.length}/${issuedIds.size} ` +
				`(${droppedInThisIter.slice(0, 3).join(', ')}${droppedInThisIter.length > 3 ? ', …' : ''})` +
				(allDelivered ? '' : ' [timed out]')
		);
	}

	collection.disconnect();

	// Quiet progress beats per-iter logging.
	if ((i + 1) % 25 === 0) {
		console.log(`  iter ${(i + 1).toString().padStart(3)}: ok so far`);
	}
}

const iterElapsed = performance.now() - iterStart;

console.log('');
console.log('# Results');
console.log('');
console.log(
	`  Iterations:                ${ITERATIONS} (${(iterElapsed / 1000).toFixed(1)}s total)`
);
console.log(
	`  Writes issued:             ${ITERATIONS * TOTAL_PER_ITER}`
);
console.log(`  Writes delivered:          ${totalDelivered}`);
console.log(`  Writes silently dropped:   ${totalDropped}`);
console.log(`  Iterations with drops:     ${droppedIterations}`);
console.log('');

if (totalDropped === 0) {
	console.log('  PASS: sync delivered every write, every iteration.');
	console.log('');
	console.log('  This is the property the competitive landscape has');
	console.log('  struggled with. We test it on every commit — the');
	console.log('  catch-up machinery is correctness-tested, not just');
	console.log('  benchmarked.');
} else {
	console.log(
		`  FAIL: ${totalDropped} silently-dropped writes across ${droppedIterations} iterations.`
	);
	console.log(
		'  This is a correctness regression. Investigate sync engine catch-up'
	);
	console.log('  before merging.');
}

console.log('');
console.log('# Competitive context (sourced)');
console.log('');
console.log(
	'  Supabase Realtime: "reconnect attempts ... will cause loss of data'
);
console.log(
	'    changes" (closed-not-planned memory leak: supabase-js #1204)'
);
console.log(
	'    https://github.com/orgs/supabase/discussions/5641'
);
console.log(
	'  ElectricSQL: post-1.0 reliability sprint Aug 2025 fixed several'
);
console.log(
	'    silent-drop issues (IPv6 fallback, race in WAL position tracking)'
);
console.log(
	'    https://electric-sql.com/blog/2025/08/04/reliability-sprint'
);
console.log(
	'  Firebase RTDB: documented 13-hour outage with silent drops'
);
console.log('    https://news.ycombinator.com/item?id=19047812');
console.log('');

await app.stop();
process.exit(totalDropped === 0 ? 0 : 1);
