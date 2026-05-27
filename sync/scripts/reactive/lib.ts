/**
 * Small reusable helpers for the reactive-read bench scripts.
 */

/**
 * Wrap a promise with a hard timeout. If `inner` doesn't resolve/reject within
 * `timeoutMs`, calls `onTimeout` (for cleanup) and rejects with `label`. Used
 * so a single stuck subscriber/snapshot can't hang the whole bench.
 */
export const withTimeout = <T>(
	inner: Promise<T>,
	timeoutMs: number,
	label: string,
	onTimeout?: () => void
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`${label} timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		inner.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});

/**
 * Poll a status function until it returns 'ready' or attempts run out. Throws
 * a descriptive error on failure — better than continuing silently with a
 * non-ready collection and producing misleading bench numbers.
 */
export const waitReady = async (
	statuses: Array<{ label: string; get: () => string }>,
	attempts = 100,
	intervalMs = 50
): Promise<void> => {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (statuses.every((entry) => entry.get() === 'ready')) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	const failing = statuses
		.filter((entry) => entry.get() !== 'ready')
		.map((entry) => `${entry.label}=${entry.get()}`)
		.join(', ');
	throw new Error(
		`collections never became ready after ${attempts * intervalMs} ms: ${failing}`
	);
};
