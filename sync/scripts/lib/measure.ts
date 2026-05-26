/**
 * Shared measurement helpers — used by bench-sync, bench-convex, bench-zero, and
 * bench-tanstack so every backend reports the same distribution under the same
 * harness (warm-up, sequential awaited round-trips, full quantiles).
 */

export type Stats = {
	count: number;
	min: number;
	p50: number;
	p95: number;
	p99: number;
	mean: number;
	max: number;
	totalMs: number;
	throughput: number;
};

export const computeStats = (latencies: number[], totalMs: number): Stats => {
	const sorted = [...latencies].sort((a, b) => a - b);
	const pick = (p: number) =>
		sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
	const mean =
		sorted.reduce((sum, value) => sum + value, 0) /
		Math.max(1, sorted.length);

	return {
		count: sorted.length,
		max: sorted[sorted.length - 1] ?? 0,
		mean,
		min: sorted[0] ?? 0,
		p50: pick(0.5),
		p95: pick(0.95),
		p99: pick(0.99),
		throughput: sorted.length / (totalMs / 1000),
		totalMs
	};
};

/**
 * Run a sequential, awaited work loop with warm-up + measurement, and return
 * the full distribution + throughput. `work` should perform one round-trip.
 */
export const measure = async (options: {
	warmup: number;
	count: number;
	work: () => Promise<unknown>;
	onProgress?: (done: number) => void;
}): Promise<Stats> => {
	for (let index = 0; index < options.warmup; index += 1) {
		await options.work();
	}

	const latencies: number[] = [];
	const start = performance.now();
	for (let index = 0; index < options.count; index += 1) {
		const at = performance.now();
		await options.work();
		latencies.push(performance.now() - at);
		if (
			options.onProgress !== undefined &&
			(index + 1) % Math.max(1, Math.floor(options.count / 4)) === 0
		) {
			options.onProgress(index + 1);
		}
	}

	return computeStats(latencies, performance.now() - start);
};

/** Print a single backend's results as a Markdown block + a one-liner row. */
export const report = (label: string, where: string, stats: Stats) => {
	const round = (value: number, digits = 2) =>
		Number(value.toFixed(digits)).toLocaleString('en-US', {
			maximumFractionDigits: digits
		});
	console.log(`# ${label} — ${where}\n`);
	console.log(`writes:           ${stats.count.toLocaleString('en-US')}`);
	console.log(`round-trip min:   ${round(stats.min, 3)} ms`);
	console.log(`round-trip p50:   ${round(stats.p50, 3)} ms`);
	console.log(`round-trip p95:   ${round(stats.p95, 3)} ms`);
	console.log(`round-trip p99:   ${round(stats.p99, 3)} ms`);
	console.log(`round-trip mean:  ${round(stats.mean, 3)} ms`);
	console.log(`round-trip max:   ${round(stats.max, 3)} ms`);
	console.log(
		`throughput:       ${Math.round(stats.throughput).toLocaleString('en-US')} writes/sec (sequential)`
	);
	console.log('');
	console.log(
		`row: | ${label} | ${where} | ${round(stats.min, 2)} | ${round(stats.p50, 2)} | ${round(stats.p95, 2)} | ${round(stats.p99, 2)} | ${round(stats.mean, 2)} | ${Math.round(stats.throughput).toLocaleString('en-US')} |`
	);
};
