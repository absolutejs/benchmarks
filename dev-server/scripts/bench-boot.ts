/**
 * Boots an app's dev server repeatedly and reports what a developer waits
 * for: the first byte, the ready banner, and the first real page.
 *
 *   bun run bench --app ~/apps/dealroom
 *   bun run bench --app ~/apps/dealroom --runs 5 --mode cold
 *   bun run bench --app ~/apps/dealroom --framework ~/abs/absolutejs
 *   bun run bench --app ~/apps/dealroom --env ABSOLUTE_DEV_EAGER=1 --label eager
 */

import { formatMs, formatSeconds, summarize } from './lib/stats';
import { sumPhases } from './lib/trace';
import {
	bootWithLock,
	installFramework,
	machineDescription,
	parseCli,
	type Mode
} from './lib/run';

const HEADLINE = ['first byte', 'ready', 'first page'] as const;
const TOP_PHASES = 6;
const TAIL_LINES = 15;

const runMode = async (
	options: ReturnType<typeof parseCli>,
	mode: Mode
) => {
	const firstByte: number[] = [];
	const ready: number[] = [];
	const firstPage: number[] = [];
	const onDemand: number[] = [];
	const loads: number[] = [];
	let phases: Array<{ durationMs: number; name: string }> = [];
	let lastStdout = '';

	for (let run = 1; run <= options.runs; run += 1) {
		process.stdout.write(`  ${mode} run ${run}/${options.runs} … `);
		const measurement = await bootWithLock(
			options,
			mode,
			run,
			options.label
		);
		if (measurement.unfinished !== null) {
			console.log(measurement.unfinished);
			console.log(
				measurement.stdout
					.split('\n')
					.filter((line) => line.trim() !== '')
					.slice(-TAIL_LINES)
					.map((line) => `      ${line}`)
					.join('\n')
			);
			continue;
		}
		firstByte.push(measurement.firstByteMs);
		ready.push(measurement.readyMs);
		firstPage.push(measurement.firstPageMs);
		onDemand.push(measurement.onDemandPageMs);
		loads.push(measurement.loadAverage);
		phases = measurement.phases;
		lastStdout = measurement.stdout;
		console.log(
			`first byte ${formatSeconds(measurement.firstByteMs)} (${measurement.firstByteStatus}), ` +
				`ready ${formatSeconds(measurement.readyMs)}, ` +
				`first page ${formatSeconds(measurement.firstPageMs)} (${measurement.firstPageStatus})`
		);
	}

	return {
		firstByte: summarize(firstByte),
		firstPage: summarize(firstPage),
		lastStdout,
		load: summarize(loads),
		onDemand: summarize(onDemand),
		phases,
		ready: summarize(ready)
	};
};

const main = async () => {
	const options = parseCli(Bun.argv.slice(2));
	if (options.framework !== null) {
		console.log(`Installing framework build from ${options.framework}`);
		await installFramework(options.app, options.framework);
	}

	console.log(`\nApp:     ${options.app}`);
	console.log(`Machine: ${machineDescription()}`);
	if (Object.keys(options.env).length > 0) {
		console.log(
			`Env:     ${Object.entries(options.env)
				.map(([key, value]) => `${key}=${value}`)
				.join(' ')}`
		);
	}

	const modes: Mode[] =
		options.mode === 'both' ? ['cold', 'warm'] : [options.mode];

	for (const mode of modes) {
		console.log(`\n${mode} boot`);
		const result = await runMode(options, mode);
		const rows = [
			['first byte', result.firstByte],
			['ready', result.ready],
			['first page', result.firstPage]
		] as const;
		console.log('');
		for (const [name, summary] of rows) {
			const pad = name.padEnd(HEADLINE[2].length + 2);
			console.log(
				`  ${pad} median ${formatSeconds(summary.median).padStart(7)}` +
					`   range ${formatSeconds(summary.min)}–${formatSeconds(summary.max)}` +
					`   spread ${summary.spreadPercent.toFixed(0)}%`
			);
		}
		if (Number.isFinite(result.onDemand.median)) {
			console.log(
				`  on-demand page  median ${formatMs(result.onDemand.median)}`
			);
		}
		console.log(`  load average at start: ${result.load.median.toFixed(2)}`);

		if (result.phases.length > 0) {
			console.log('\n  slowest build phases (last run)');
			for (const phase of result.phases.slice(0, TOP_PHASES)) {
				console.log(
					`    ${formatSeconds(phase.durationMs).padStart(7)}  ${phase.name}`
				);
			}
			const post = sumPhases(
				{ phases: result.phases, totalMs: Number.NaN },
				'postprocess/'
			);
			if (post > 0) {
				console.log(
					`    ${formatSeconds(post).padStart(7)}  postprocess/* (total)`
				);
			}
		}
	}

	console.log('\nRaw runs appended to results/runs.jsonl');
};

await main();
