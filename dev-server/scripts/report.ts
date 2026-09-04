/**
 * Summarises everything in `results/runs.jsonl`, grouped by label and mode.
 *
 *   bun run report
 *   bun run report --label eager
 */

import { join, resolve } from 'node:path';
import { formatMs, formatSeconds, summarize } from './lib/stats';
import type { RunRecord } from './lib/run';

/* Written by `lib/run.ts` into this project's own results directory. */
const RESULTS = join(resolve(import.meta.dir, '..'), 'results', 'runs.jsonl');

const main = async () => {
	const raw = await Bun.file(RESULTS)
		.text()
		.catch(() => '');
	if (raw.trim() === '') {
		console.log(`No results yet at ${RESULTS}. Run \`bun run bench\` first.`);

		return;
	}

	const argv = Bun.argv.slice(2);
	const only = argv.indexOf('--label');
	const wanted = only === -1 ? null : argv[only + 1];

	const records = raw
		.split('\n')
		.filter((line) => line.trim() !== '')
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as RunRecord];
			} catch {
				return [];
			}
		})
		.filter((record) => wanted === null || record.label === wanted);

	const groups = new Map<string, RunRecord[]>();
	for (const record of records) {
		const key = `${record.label} · ${record.mode}`;
		groups.set(key, [...(groups.get(key) ?? []), record]);
	}

	console.log(
		`\n  group                     runs  first byte   ready        first page   on-demand`
	);
	for (const [key, group] of [...groups.entries()].sort()) {
		const firstByte = summarize(
			group.map((record) => record.measurement.firstByteMs)
		);
		const ready = summarize(
			group.map((record) => record.measurement.readyMs)
		);
		const firstPage = summarize(
			group.map((record) => record.measurement.firstPageMs)
		);
		const onDemand = summarize(
			group.map((record) => record.measurement.onDemandPageMs)
		);
		console.log(
			`  ${key.padEnd(25)} ${String(group.length).padStart(4)}  ` +
				`${formatSeconds(firstByte.median).padEnd(12)} ` +
				`${formatSeconds(ready.median).padEnd(12)} ` +
				`${formatSeconds(firstPage.median).padEnd(12)} ` +
				`${formatMs(onDemand.median)}`
		);
	}
	console.log('\n  Medians. See runs.jsonl for every raw run and its load average.');
};

await main();
