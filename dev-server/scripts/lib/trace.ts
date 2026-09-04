/**
 * Reads the build trace `absolute dev` writes under
 * `<buildDir>/.absolute-trace/` when `ABSOLUTE_DEV_PROFILE=1` is set.
 *
 * The trace is what turns "the boot got slower" into "the Vue compile got
 * slower", so a run without one is still reported, just with less detail.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type BuildTrace = {
	/** Phase name to duration in milliseconds, largest first. */
	phases: Array<{ durationMs: number; name: string }>;
	totalMs: number;
};

type TraceFile = {
	events?: Array<{ durationMs?: number; name?: string }>;
	totalDurationMs?: number;
};

const EMPTY: BuildTrace = { phases: [], totalMs: Number.NaN };

export const readTrace = async (
	buildDirectory: string
): Promise<BuildTrace> => {
	const directory = join(buildDirectory, '.absolute-trace');
	const names = await readdir(directory).catch(() => []);
	const traces = names.filter((name) => name.endsWith('.json')).sort();
	const newest = traces[traces.length - 1];
	if (newest === undefined) return EMPTY;

	const raw = await readFile(join(directory, newest), 'utf8').catch(
		() => null
	);
	if (raw === null) return EMPTY;

	let parsed: TraceFile;
	try {
		parsed = JSON.parse(raw) as TraceFile;
	} catch {
		return EMPTY;
	}

	const phases = (parsed.events ?? [])
		.flatMap((event) =>
			typeof event.name === 'string' &&
			typeof event.durationMs === 'number'
				? [{ durationMs: event.durationMs, name: event.name }]
				: []
		)
		.sort((left, right) => right.durationMs - left.durationMs);

	return {
		phases,
		totalMs: parsed.totalDurationMs ?? Number.NaN
	};
};

/** Sums the phases whose name starts with `prefix`. */
export const sumPhases = (trace: BuildTrace, prefix: string) =>
	trace.phases
		.filter((phase) => phase.name.startsWith(prefix))
		.reduce((total, phase) => total + phase.durationMs, 0);
