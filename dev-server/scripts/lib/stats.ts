/**
 * Summary statistics for repeated boot runs.
 *
 * A dev-server boot is not a microbenchmark: one run costs several seconds
 * and several gigabytes, so a sample is a handful of runs rather than
 * thousands. Quantiles over five samples would be theatre, so this reports
 * the median (the honest middle of a small sample), the spread, and every
 * raw value — enough for a reader to see when two configurations are simply
 * not distinguishable.
 */

export type Summary = {
	count: number;
	max: number;
	median: number;
	min: number;
	/** Max minus min, as a percentage of the median. */
	spreadPercent: number;
	values: number[];
};

const MISSING = Number.NaN;
const PERCENT = 100;

export const summarize = (values: readonly number[]): Summary => {
	const usable = values.filter((value) => Number.isFinite(value));
	if (usable.length === 0) {
		return {
			count: 0,
			max: MISSING,
			median: MISSING,
			min: MISSING,
			spreadPercent: MISSING,
			values: [...values]
		};
	}
	const sorted = [...usable].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
			: (sorted[middle] ?? 0);
	const min = sorted[0] ?? 0;
	const max = sorted[sorted.length - 1] ?? 0;

	return {
		count: sorted.length,
		max,
		median,
		min,
		spreadPercent: median === 0 ? 0 : ((max - min) / median) * PERCENT,
		values: [...values]
	};
};

const SECOND = 1000;
const DECIMALS = 2;

export const formatSeconds = (ms: number) =>
	Number.isFinite(ms) ? `${(ms / SECOND).toFixed(DECIMALS)}s` : '—';

export const formatMs = (ms: number) =>
	Number.isFinite(ms) ? `${Math.round(ms)}ms` : '—';

/**
 * Two runs of the same configuration can differ by more than most changes
 * do, so a single run per side can only ever produce a coin flip dressed up
 * as a result.
 */
export const MINIMUM_SAMPLES = 3;

export type Comparison =
	| { kind: 'difference'; fasterIsLeft: boolean; gap: number }
	| { kind: 'insufficient'; needed: number }
	| { kind: 'tie' };

/**
 * Whether two samples are far enough apart to be worth reporting as a
 * difference.
 *
 * Boot timings on a shared machine drift by tens of percent between runs, so
 * a naive "B is 8% faster" reads as signal when it is noise. A difference
 * counts only when there are enough runs to see the spread at all, the
 * medians differ by more than the noise floor, AND the two samples' ranges
 * do not overlap — the same bar a reader would apply by eye to the raw
 * values.
 */
export const compareSamples = (
	left: Summary,
	right: Summary,
	noiseFloorPercent: number
): Comparison => {
	if (left.count < MINIMUM_SAMPLES || right.count < MINIMUM_SAMPLES) {
		return {
			kind: 'insufficient',
			needed: MINIMUM_SAMPLES - Math.min(left.count, right.count)
		};
	}
	const gap = Math.abs(left.median - right.median);
	const reference = Math.min(left.median, right.median);
	if (reference === 0) return { kind: 'tie' };
	if ((gap / reference) * PERCENT < noiseFloorPercent) return { kind: 'tie' };
	if (left.max >= right.min && right.max >= left.min) return { kind: 'tie' };

	return { fasterIsLeft: left.median < right.median, gap, kind: 'difference' };
};
