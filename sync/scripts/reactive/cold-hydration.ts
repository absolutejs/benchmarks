/**
 * Reactive-read bench #2 — cold hydration.
 *
 * How long does the initial snapshot take to arrive on a fresh client when
 * the table has N rows? This is the "I opened your app for the first time"
 * latency — and where snapshot vs incremental-delta engine choices matter.
 *
 * Methodology: seed the table with N rows, spin up the engine + socket,
 * then open a fresh subscriber and measure time-to-ready (i.e. status
 * transitions from `connecting` → `ready` with the full snapshot in
 * `state.data`). Repeated K times with a fresh subscriber each time, so
 * the measurement is per-cold-open, not per-resume.
 *
 * Run: bun run scripts/reactive/cold-hydration.ts
 */
import { Elysia } from 'elysia';
import { syncSocket } from '@absolutejs/sync';
import {
	createSyncEngine,
	defineReactiveQuery
} from '@absolutejs/sync/engine';
import { createSyncCollection } from '@absolutejs/sync/client';
import { ensureSchema, readAllTasks, seedTasks, sql } from './tasks-db';
import { withTimeout } from './lib';
import { computeStats } from '../lib/measure';

const PORT = 4351;

type Row = {
	id: string;
	title: string;
	assignee: string;
	priority: number;
	done: boolean;
	createdAt: number;
};

await ensureSchema();

const engine = createSyncEngine();
engine.registerReader('tasks', { all: () => readAllTasks() });
engine.registerReactive(
	defineReactiveQuery<Row>({
		key: (row) => row.id,
		name: 'tasks',
		run: ({ db }) => db.all<Row>('tasks')
	})
);

const app = new Elysia().use(syncSocket({ engine })).listen(PORT);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = `ws://localhost:${PORT}/sync/ws`;

const round = (value: number, digits = 2) =>
	Number(value.toFixed(digits)).toLocaleString('en-US', {
		maximumFractionDigits: digits
	});

const HYDRATE_TIMEOUT_MS = 30_000;
const hydrateOnce = (): Promise<number> => {
	const startedAt = performance.now();
	const sub = createSyncCollection<Row>({ collection: 'tasks', url });
	let unsubscribe: () => void = () => {};
	const inner = new Promise<number>((resolve) => {
		unsubscribe = sub.subscribe((state) => {
			if (state.status === 'ready') {
				const elapsed = performance.now() - startedAt;
				unsubscribe();
				sub.close();
				resolve(elapsed);
			}
		});
	});

	return withTimeout(inner, HYDRATE_TIMEOUT_MS, 'hydrateOnce', () => {
		unsubscribe();
		sub.close();
	});
};

const measureAtSize = async (rowCount: number) => {
	await seedTasks(rowCount);
	// Settle so the bulk insert isn't still being committed when we measure.
	await sleep(200);

	const warmup = 3;
	const measured = 15;
	for (let index = 0; index < warmup; index += 1) {
		await hydrateOnce();
	}
	const samples: number[] = [];
	const start = performance.now();
	for (let index = 0; index < measured; index += 1) {
		samples.push(await hydrateOnce());
	}

	return computeStats(samples, performance.now() - start);
};

const results: Array<{
	rows: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}> = [];
for (const rows of [100, 1_000, 10_000, 100_000]) {
	console.log(`# seeding ${rows.toLocaleString('en-US')} rows…`);
	const stats = await measureAtSize(rows);
	console.log(
		`  cold-open: p50 ${round(stats.p50, 2)} ms · p95 ${round(stats.p95, 2)} ms · p99 ${round(stats.p99, 2)} ms · max ${round(stats.max, 2)} ms`
	);
	results.push({
		max: stats.max,
		p50: stats.p50,
		p95: stats.p95,
		p99: stats.p99,
		rows
	});
}

console.log('\n## Cold hydration — fresh subscriber → ready (full snapshot)\n');
console.log(
	'| rows | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |'
);
console.log('|---|---|---|---|---|');
for (const row of results) {
	console.log(
		`| ${row.rows.toLocaleString('en-US')} | ${round(row.p50, 1)} | ${round(row.p95, 1)} | ${round(row.p99, 1)} | ${round(row.max, 1)} |`
	);
}

try {
	await app.stop();
} catch (error) {
	console.error('app.stop() failed:', error);
}
await sql.end();
process.exit(0);
