/**
 * Compares two dev-server configurations on the same app, alternating
 * between them.
 *
 * Why alternating, and why this script exists at all: boot timings on a
 * developer machine drift. Anything else running — another build, a test
 * suite, a browser — moves them by tens of percent, and the drift is not
 * random noise that averages out, it is a slow ramp. Running every A then
 * every B attributes that ramp to B. This project was written after exactly
 * that mistake: two measurements of the same change, taken minutes apart,
 * "proved" it both a large win and a large regression. Alternating A/B/A/B
 * and reporting the spread alongside the median makes a tie look like a tie.
 *
 *   # a feature flag
 *   bun run compare --app ~/apps/dealroom \
 *     --a-env ABSOLUTE_DEV_PRESCAN=0 --b-env ABSOLUTE_DEV_PRESCAN=1
 *
 *   # two framework checkouts
 *   bun run compare --app ~/apps/dealroom \
 *     --a-framework ~/abs/absolutejs-main --b-framework ~/abs/absolutejs
 */

import {
	compareSamples,
	formatMs,
	formatSeconds,
	MINIMUM_SAMPLES,
	summarize,
	type Summary
} from './lib/stats';
import {
	bootWithLock,
	installFramework,
	machineDescription,
	parseCli,
	parseEnvPairs,
	type Mode
} from './lib/run';

/**
 * Below this, two medians are called a tie regardless of ordering. Boot
 * timings routinely move this much between identical runs.
 */
const NOISE_FLOOR_PERCENT = 10;

type Side = {
	env: Record<string, string>;
	framework: string | null;
	label: string;
};

const readFlag = (argv: string[], name: string) => {
	const index = argv.indexOf(`--${name}`);

	return index === -1 ? null : (argv[index + 1] ?? null);
};

const readRepeated = (argv: string[], name: string) =>
	argv.flatMap((value, index) =>
		value === `--${name}` ? [argv[index + 1] ?? ''] : []
	);

const readSide = (argv: string[], prefix: 'a' | 'b'): Side => {
	const framework = readFlag(argv, `${prefix}-framework`);

	return {
		env: parseEnvPairs(readRepeated(argv, `${prefix}-env`)),
		framework,
		label: readFlag(argv, `${prefix}-label`) ?? prefix.toUpperCase()
	};
};

const describeSide = (side: Side) => {
	const parts = [
		...Object.entries(side.env).map(([key, value]) => `${key}=${value}`),
		...(side.framework === null ? [] : [`framework=${side.framework}`])
	];

	return parts.length === 0 ? 'defaults' : parts.join(' ');
};

type Samples = {
	firstByte: number[];
	firstPage: number[];
	onDemand: number[];
	ready: number[];
};

const emptySamples = (): Samples => ({
	firstByte: [],
	firstPage: [],
	onDemand: [],
	ready: []
});

const PERCENT = 100;

const verdict = (
	left: Summary,
	right: Summary,
	leftName: string,
	rightName: string
) => {
	const result = compareSamples(left, right, NOISE_FLOOR_PERCENT);
	if (result.kind === 'insufficient') {
		return `not enough runs (need ${MINIMUM_SAMPLES} per side)`;
	}
	if (result.kind === 'tie') return 'tie (within run-to-run noise)';
	const faster = result.fasterIsLeft ? leftName : rightName;
	const reference = Math.max(left.median, right.median);
	const share = ((result.gap / reference) * PERCENT).toFixed(0);

	return `${faster} faster by ${formatSeconds(result.gap)} (${share}%)`;
};

const main = async () => {
	const argv = Bun.argv.slice(2);
	const options = parseCli(argv);
	const sides: [Side, Side] = [readSide(argv, 'a'), readSide(argv, 'b')];
	const mode: Mode = options.mode === 'both' ? 'warm' : options.mode;

	console.log(`\nApp:     ${options.app}`);
	console.log(`Machine: ${machineDescription()}`);
	console.log(`Mode:    ${mode}, ${options.runs} run(s) per side, alternating`);
	console.log(`  ${sides[0].label}: ${describeSide(sides[0])}`);
	console.log(`  ${sides[1].label}: ${describeSide(sides[1])}\n`);

	const samples: [Samples, Samples] = [emptySamples(), emptySamples()];
	let installed: string | null = null;

	for (let round = 1; round <= options.runs; round += 1) {
		for (const [index, side] of sides.entries()) {
			if (side.framework !== null && side.framework !== installed) {
				await installFramework(options.app, side.framework);
				installed = side.framework;
			}
			process.stdout.write(
				`  round ${round} ${side.label.padEnd(8)} … `
			);
			const measurement = await bootWithLock(
				{ ...options, env: { ...options.env, ...side.env } },
				mode,
				round,
				side.label
			);
			if (measurement.unfinished !== null) {
				console.log(measurement.unfinished);
				continue;
			}
			const bucket = samples[index];
			if (bucket === undefined) continue;
			bucket.firstByte.push(measurement.firstByteMs);
			bucket.ready.push(measurement.readyMs);
			bucket.firstPage.push(measurement.firstPageMs);
			bucket.onDemand.push(measurement.onDemandPageMs);
			console.log(
				`first byte ${formatSeconds(measurement.firstByteMs)}, ` +
					`ready ${formatSeconds(measurement.readyMs)}, ` +
					`first page ${formatSeconds(measurement.firstPageMs)}`
			);
		}
	}

	const [a, b] = samples;
	if (a === undefined || b === undefined) return;

	const metrics = [
		['first byte', a.firstByte, b.firstByte, formatSeconds],
		['ready', a.ready, b.ready, formatSeconds],
		['first page', a.firstPage, b.firstPage, formatSeconds],
		['on-demand page', a.onDemand, b.onDemand, formatMs]
	] as const;

	console.log('\n  metric           %s  %s  verdict'.replace('%s', sides[0].label.padEnd(16)).replace('%s', sides[1].label.padEnd(16)));
	for (const [name, left, right, format] of metrics) {
		const leftSummary = summarize(left);
		const rightSummary = summarize(right);
		if (leftSummary.count === 0 && rightSummary.count === 0) continue;
		console.log(
			`  ${name.padEnd(16)} ${format(leftSummary.median).padEnd(16)}  ` +
				`${format(rightSummary.median).padEnd(16)}  ` +
				verdict(
					leftSummary,
					rightSummary,
					sides[0].label,
					sides[1].label
				)
		);
	}

	console.log(
		`\n  A tie means the two are not separable on this machine, not that\n` +
			`  the change does nothing — re-run with more --runs, or on an idle box.`
	);
};

await main();
