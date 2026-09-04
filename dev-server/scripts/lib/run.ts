/**
 * Shared plumbing for the benchmark entrypoints: argument parsing, the
 * machine lock, framework injection, and the result record written to disk.
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { bootOnce, type BootMeasurement } from './devServer';

export type Mode = 'cold' | 'warm';

export type RunRecord = {
	app: string;
	env: Record<string, string>;
	label: string;
	measurement: Omit<BootMeasurement, 'stdout'>;
	mode: Mode;
	run: number;
	startedAt: string;
};

const LOCK_PATH = '/tmp/absolutejs-dev-server-bench.lock';
const LOCK_POLL_MS = 2000;
const LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * One boot at a time, machine-wide.
 *
 * A dev boot of a large app peaks around five gigabytes. Two at once do not
 * merely produce noisy numbers, they swap the machine and produce numbers
 * that look like a regression. The lock is advisory and file-based so it also
 * holds across separate shells and separate people.
 */
export const withMachineLock = async <T>(work: () => Promise<T>) => {
	for (;;) {
		const existing = Bun.file(LOCK_PATH);
		if (await existing.exists()) {
			const held = Number.parseInt(await existing.text(), 10);
			const age = Date.now() - (Number.isFinite(held) ? held : 0);
			if (age < LOCK_STALE_MS) {
				await Bun.sleep(LOCK_POLL_MS);
				continue;
			}
		}
		await writeFile(LOCK_PATH, String(Date.now()));
		break;
	}
	try {
		return await work();
	} finally {
		await rm(LOCK_PATH, { force: true });
	}
};

/**
 * Installs a framework build into the app under test.
 *
 * Benchmarks that compare framework revisions have to swap `dist`, not the
 * whole package: the app's `node_modules` copy carries the package manifest
 * the app resolved against, and replacing that changes more than the code
 * under test.
 */
export const installFramework = async (
	appDirectory: string,
	frameworkDirectory: string
) => {
	const target = join(
		appDirectory,
		'node_modules',
		'@absolutejs',
		'absolute',
		'dist'
	);
	const source = join(frameworkDirectory, 'dist');
	if (!(await Bun.file(join(source, 'index.js')).exists())) {
		throw new Error(
			`No build at ${source}. Run \`bun run build\` in ${frameworkDirectory} first.`
		);
	}
	await rm(target, { force: true, recursive: true });
	await cp(source, target, { recursive: true });
};

export type CliOptions = {
	app: string;
	env: Record<string, string>;
	framework: string | null;
	label: string;
	mode: Mode | 'both';
	path: string;
	port: number;
	runs: number;
	timeoutMs: number;
};

const DEFAULT_PORT = 47_800;
const DEFAULT_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 600_000;

const readFlag = (argv: string[], name: string) => {
	const index = argv.indexOf(`--${name}`);

	return index === -1 ? null : (argv[index + 1] ?? null);
};

const readRepeated = (argv: string[], name: string) =>
	argv.flatMap((value, index) =>
		value === `--${name}` ? [argv[index + 1] ?? ''] : []
	);

export const parseEnvPairs = (pairs: readonly string[]) =>
	Object.fromEntries(
		pairs
			.filter((pair) => pair.includes('='))
			.map((pair) => {
				const at = pair.indexOf('=');

				return [pair.slice(0, at), pair.slice(at + 1)] as const;
			})
	);

export const parseCli = (argv: string[]): CliOptions => {
	const app = readFlag(argv, 'app');
	if (app === null) {
		throw new Error(
			'--app <path> is required (the AbsoluteJS app to boot).'
		);
	}
	const mode = readFlag(argv, 'mode') ?? 'both';
	if (mode !== 'cold' && mode !== 'warm' && mode !== 'both') {
		throw new Error('--mode must be cold, warm or both.');
	}
	const framework = readFlag(argv, 'framework');

	return {
		app: resolve(app),
		env: parseEnvPairs(readRepeated(argv, 'env')),
		framework: framework === null ? null : resolve(framework),
		label: readFlag(argv, 'label') ?? 'run',
		mode,
		path: readFlag(argv, 'path') ?? '/',
		port: Number.parseInt(readFlag(argv, 'port') ?? '', 10) || DEFAULT_PORT,
		runs: Number.parseInt(readFlag(argv, 'runs') ?? '', 10) || DEFAULT_RUNS,
		timeoutMs:
			Number.parseInt(readFlag(argv, 'timeout') ?? '', 10) ||
			DEFAULT_TIMEOUT_MS
	};
};

export const machineDescription = () => {
	const gib = totalmem() / 1024 ** 3;

	return `${hostname()} · ${cpus().length} vCPU · ${gib.toFixed(0)} GiB · Bun ${Bun.version}`;
};

const RESULTS_DIR = resolve(import.meta.dir, '..', '..', 'results');

export const appendResult = async (record: RunRecord) => {
	await mkdir(RESULTS_DIR, { recursive: true });
	const path = join(RESULTS_DIR, 'runs.jsonl');
	const existing = (await Bun.file(path).text().catch(() => '')) || '';
	await writeFile(path, `${existing}${JSON.stringify(record)}\n`);
};

export const bootWithLock = async (
	options: CliOptions,
	mode: Mode,
	run: number,
	label: string
) =>
	withMachineLock(async () => {
		const measurement = await bootOnce({
			appDirectory: options.app,
			cold: mode === 'cold',
			env: options.env,
			path: options.path,
			port: options.port,
			timeoutMs: options.timeoutMs
		});
		const { stdout, ...rest } = measurement;
		await appendResult({
			app: options.app,
			env: options.env,
			label,
			measurement: rest,
			mode,
			run,
			startedAt: new Date().toISOString()
		});

		return measurement;
	});
