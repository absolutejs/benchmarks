/**
 * Reactive-read bench #5 — multi-row transaction throughput.
 *
 * The shared-counter bench measures one-row writes. Real workloads commit
 * multiple rows in a single transaction (an order + its line items, a doc +
 * its blocks, etc.). This bench measures sustained inserts/sec at varying
 * batch sizes — 1, 10, 100, 1000 rows per commit — through the sync engine
 * + Postgres, with a subscriber on the same `tasks` collection so the engine
 * also has to fan out the change set.
 *
 * Run: bun run scripts/reactive/multi-row-tx.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineMutation,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import {
	ensureSchema,
	insertManyInTx,
	readAllTasks,
	seedTasks,
	sql,
	type Task
} from './tasks-db';
import { waitReady } from './lib';

const PORT = 4354;

type Row = Task;

await ensureSchema();
await seedTasks(0); // start empty

let nextId = 0;

const engine = createSyncEngine();
engine.registerReader('tasks', { all: () => readAllTasks() });
engine.registerWriter<Row>('tasks', {
	delete: () => {},
	insert: async (data: Partial<Row> & { rows?: Row[] }) => {
		// Two modes: batch via .rows, or single via standard insert.
		if (Array.isArray(data.rows)) {
			if (data.rows.length === 0) {
				throw new Error('empty batch passed to multi-row-tx insert');
			}
			await insertManyInTx(data.rows);
			// Non-null since we guarded length above.
			return data.rows[0] as Row;
		}
		const row: Row = {
			assignee: data.assignee ?? 'alex',
			createdAt: Date.now(),
			done: false,
			id: data.id ?? `m-${nextId++}`,
			priority: 0,
			title: data.title ?? 'x'
		};
		await insertManyInTx([row]);

		return row;
	},
	update: async () => ({
		assignee: 'alex',
		createdAt: 0,
		done: false,
		id: 'noop',
		priority: 0,
		title: ''
	})
});
engine.registerReactive(
	defineReactiveQuery<Row>({
		key: (row) => row.id,
		name: 'tasks',
		run: ({ db }) => db.all<Row>('tasks')
	})
);
engine.registerMutation(
	defineMutation({
		handler: (args: { batchSize: number }, _ctx, actions) => {
			const rows: Row[] = Array.from(
				{ length: args.batchSize },
				(_, index) => ({
					assignee: 'alex',
					createdAt: Date.now(),
					done: false,
					id: `b-${nextId++}-${index}`,
					priority: index,
					title: `batch ${index}`
				})
			);

			return actions.insert<Row>('tasks', { rows });
		},
		name: 'insertBatch'
	})
);

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = `ws://localhost:${PORT}/sync/ws`;

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

// A subscriber that exists to make fan-out a real cost, not a no-op.
const subscriber = createSyncCollection<Row>({ collection: 'tasks', url });
const writer = createSyncCollection<Row>({ collection: 'tasks', url });
await waitReady([
	{ get: () => writer.get().status, label: 'writer' },
	{ get: () => subscriber.get().status, label: 'subscriber' }
]);

const measureBatch = async (batchSize: number) => {
	// Reset between batch-size runs so the table doesn't grow without bound.
	await seedTasks(0);
	nextId = 0;
	await sleep(100);

	const warmup = 3;
	const measured = 25;
	for (let index = 0; index < warmup; index += 1) {
		await writer.mutate({ args: { batchSize }, name: 'insertBatch' });
	}
	const start = performance.now();
	for (let index = 0; index < measured; index += 1) {
		await writer.mutate({ args: { batchSize }, name: 'insertBatch' });
	}
	const elapsedSec = (performance.now() - start) / 1000;
	const commits = measured;
	const rowsCommitted = measured * batchSize;

	return {
		commitsPerSec: commits / elapsedSec,
		rowsPerSec: rowsCommitted / elapsedSec
	};
};

const results: Array<{
	batchSize: number;
	commitsPerSec: number;
	rowsPerSec: number;
}> = [];
for (const batchSize of [1, 10, 100, 1_000]) {
	console.log(`# batch size: ${batchSize}…`);
	const out = await measureBatch(batchSize);
	console.log(
		`  ${Math.round(out.commitsPerSec).toLocaleString('en-US')} commits/sec · ${Math.round(out.rowsPerSec).toLocaleString('en-US')} rows/sec`
	);
	results.push({
		batchSize,
		commitsPerSec: out.commitsPerSec,
		rowsPerSec: out.rowsPerSec
	});
}

console.log(
	'\n## Multi-row transaction throughput — sequential awaited commits\n'
);
console.log(
	'| rows/commit | commits/sec | rows/sec |'
);
console.log('|---|---|---|');
for (const row of results) {
	console.log(
		`| ${row.batchSize.toLocaleString('en-US')} | ${Math.round(row.commitsPerSec).toLocaleString('en-US')} | ${Math.round(row.rowsPerSec).toLocaleString('en-US')} |`
	);
}

subscriber.close();
writer.close();
void app.stop();
await sql.end();
process.exit(0);
