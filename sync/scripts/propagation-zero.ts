/**
 * Zero propagation-latency benchmark — write → remote-subscriber-receive.
 *
 * Two Zero clients connect to the same `zero-cache`: one bumps the counter via
 * the custom mutator (which the push server runs against Postgres), the other
 * materialises the row and listens. Per-iteration latency = time from issuing
 * the mutation to the subscriber's view carrying the new n.
 *
 * Same prerequisites as bench-zero (zero-cache + push server + PG running).
 * Run: bun run scripts/propagation-zero.ts
 */
import { Zero, createBuilder } from '@rocicorp/zero';
import { schema } from '../zero/schema';
import { createMutators } from '../zero/mutators';
import { computeStats } from './lib/measure';

const sleep = (timeMs: number) =>
	new Promise((resolve) => setTimeout(resolve, timeMs));

const make = (label: string) =>
	new Zero({
		auth: undefined,
		mutators: createMutators(),
		schema,
		server: 'http://localhost:4848',
		userID: `prop-${label}-${Math.random().toString(36).slice(2, 8)}`
	});

const writer = make('w');
const subscriber = make('s');

// Materialise the counter row on the subscriber so changes push into `view.data`.
const zql = createBuilder(schema);
const view = subscriber.materialize(zql.counters.where('id', '=', 'c'));

// Let both WS handshakes + initial materialisation settle.
await sleep(800);

const currentN = (): number => {
	const row = view.data[0] as { n?: number } | undefined;

	return typeof row?.n === 'number' ? row.n : -1;
};

let lastSeen = currentN();

const propagate = (): Promise<number> =>
	new Promise<number>((resolve, reject) => {
		const startedAt = performance.now();
		const expected = lastSeen + 1;

		// Subscribe BEFORE issuing the mutation so we never miss a fast push.
		const unsubscribe = view.addListener(() => {
			const seen = currentN();
			if (seen >= expected) {
				lastSeen = seen;
				unsubscribe();
				resolve(performance.now() - startedAt);
			}
		});

		const pending = writer.mutate.counter.bump({});
		const promise = (pending as unknown as { server?: Promise<unknown> })
			.server;
		(promise ?? pending).catch((error: unknown) => {
			unsubscribe();
			reject(error);
		});
	});

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
console.log(`# Zero — write → remote-subscriber-receive\n`);
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
	`row: | Zero | local (zero-cache + push + PG) | ${round(stats.min, 2)} | ${round(stats.p50, 2)} | ${round(stats.p95, 2)} | ${round(stats.p99, 2)} | ${round(stats.mean, 2)} |`
);

view.destroy();
writer.close();
subscriber.close();
process.exit(0);
