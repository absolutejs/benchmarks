/**
 * Boots an AbsoluteJS app's dev server once and measures what a person
 * actually waits for.
 *
 * Three moments matter, and they are not the same moment:
 *
 *   firstByteMs  the port answers at all. With the early listener this is a
 *                503 "building" page, which is what stops a browser showing
 *                "connection refused".
 *   readyMs      the framework prints its ready banner. The server is up,
 *                but on a lazy dev build the page you asked for may still
 *                need building.
 *   firstPageMs  a real page (not a 503) comes back. This is the number a
 *                developer would call "how long until I can work".
 *
 * Everything else here exists to make those three numbers trustworthy.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readTrace, type BuildTrace } from './trace';

export type BootMeasurement = {
	buildTraceMs: number;
	exitedEarly: boolean;
	firstByteMs: number;
	firstByteStatus: number;
	firstPageMs: number;
	firstPageStatus: number;
	loadAverage: number;
	onDemandPageMs: number;
	phases: BuildTrace['phases'];
	readyMs: number;
	stdout: string;
	/** Set when the run ended without a real page, with the reason. */
	unfinished: string | null;
};

export type BootOptions = {
	/** Absolute path to the app under test. */
	appDirectory: string;
	/** Removed before booting when `mode` is `cold`. */
	cold: boolean;
	/** Extra environment for the dev process, e.g. feature flags under test. */
	env: Record<string, string>;
	/** Path requested once the port answers. */
	path: string;
	port: number;
	/** Hard stop, in case a boot wedges. */
	timeoutMs: number;
};

const POLL_INTERVAL_MS = 100;
const REQUEST_TIMEOUT_MS = 2000;
const SERVICE_UNAVAILABLE = 503;
const SETTLE_MS = 1500;
const ANSI = /\[[0-9;?]*[A-Za-z]/g;

const now = () => performance.now();

const loadAverage = async () => {
	const raw = await Bun.file('/proc/loadavg')
		.text()
		.catch(() => '');

	return Number.parseFloat(raw.split(' ')[0] ?? '') || 0;
};

/**
 * Kills the whole dev process tree.
 *
 * The `absolute` CLI supervises a `bun --hot` child. Killing the child (or
 * freeing the port) makes the parent respawn it, which on a large app leaves
 * a multi-gigabyte server running forever — this is the single easiest way
 * to wreck a benchmark machine, so the parent goes first and the group is
 * swept afterwards.
 */
const killTree = async (pid: number) => {
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	}
	await Bun.sleep(SETTLE_MS);
};

const probe = async (url: string) => {
	try {
		const response = await fetch(url, {
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		await response.body?.cancel();

		return response.status;
	} catch {
		return 0;
	}
};

const READY_LINE = /ready in\s+([0-9]+m\s*)?([0-9.]+)\s*(ms|s)\b/;
const ON_DEMAND_LINE = /^\s+-\s+\S+:\s+([0-9.]+)(ms|s)\s*$/mu;

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

/** The framework prints `ready in 1m 3s` or `ready in 812.40ms`. */
const parseReady = (output: string) => {
	const match = READY_LINE.exec(output);
	if (!match) return Number.NaN;
	const minutes = match[1] ? Number.parseFloat(match[1]) * MINUTE_MS : 0;
	const value = Number.parseFloat(match[2] ?? '');
	if (!Number.isFinite(value)) return Number.NaN;

	return minutes + (match[3] === 's' ? value * SECOND_MS : value);
};

/** The first `- <Page>: 812.40ms` under the on-demand build heading. */
const parseOnDemand = (output: string) => {
	const section = output.split('on-demand page build')[1];
	if (section === undefined) return Number.NaN;
	const match = ON_DEMAND_LINE.exec(section);
	if (!match) return Number.NaN;
	const value = Number.parseFloat(match[1] ?? '');

	return match[2] === 's' ? value * SECOND_MS : value;
};

export const bootOnce = async (
	options: BootOptions
): Promise<BootMeasurement> => {
	const buildDirectory = join(options.appDirectory, 'build');
	const cacheDirectory = join(options.appDirectory, '.absolutejs');
	if (options.cold) {
		await rm(buildDirectory, { force: true, recursive: true });
		await rm(cacheDirectory, { force: true, recursive: true });
	}

	const load = await loadAverage();
	const url = `http://127.0.0.1:${options.port}${options.path}`;
	const chunks: string[] = [];
	const startedAt = now();

	const child = Bun.spawn(['bun', 'run', 'dev'], {
		cwd: options.appDirectory,
		env: {
			...process.env,
			...options.env,
			ABSOLUTE_DEV_PROFILE: '1',
			PORT: String(options.port)
		},
		stderr: 'pipe',
		// Its own process group, so the supervisor tree dies as one.
		stdio: ['ignore', 'pipe', 'pipe'],
		...({ detached: true } as Record<string, unknown>)
	});

	const drain = async (stream: ReadableStream<Uint8Array> | null) => {
		if (!stream) return;
		const decoder = new TextDecoder();
		for await (const part of stream) chunks.push(decoder.decode(part));
	};
	void drain(child.stdout);
	void drain(child.stderr);

	let firstByteMs = Number.NaN;
	let firstByteStatus = 0;
	let firstPageMs = Number.NaN;
	let firstPageStatus = 0;
	let exitedEarly = false;

	while (now() - startedAt < options.timeoutMs) {
		if (child.exitCode !== null) {
			exitedEarly = true;
			break;
		}
		const status = await probe(url);
		if (status !== 0 && !Number.isFinite(firstByteMs)) {
			firstByteMs = now() - startedAt;
			firstByteStatus = status;
		}
		if (status !== 0 && status !== SERVICE_UNAVAILABLE) {
			firstPageMs = now() - startedAt;
			firstPageStatus = status;
			break;
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}

	// Let the profile block finish printing before the output is read.
	await Bun.sleep(SETTLE_MS);
	await killTree(child.pid);

	const stdout = chunks.join('').replace(ANSI, '');
	const trace = await readTrace(buildDirectory);

	const unfinished = exitedEarly
		? 'the dev server exited before serving a page'
		: Number.isFinite(firstPageMs)
			? null
			: Number.isFinite(firstByteMs)
				? `the port answered ${firstByteStatus} but no page arrived within ${Math.round(options.timeoutMs / SECOND_MS)}s — the app may be missing environment it needs to boot`
				: `nothing answered on port ${options.port} within ${Math.round(options.timeoutMs / SECOND_MS)}s`;

	return {
		buildTraceMs: trace.totalMs,
		exitedEarly,
		firstByteMs,
		firstByteStatus,
		firstPageMs,
		firstPageStatus,
		loadAverage: load,
		onDemandPageMs: parseOnDemand(stdout),
		phases: trace.phases,
		readyMs: parseReady(stdout),
		stdout,
		unfinished
	};
};
