/**
 * Phase-by-phase profile of the FFI hot path for sync.sandboxedHandler.
 * Each per-call mutation goes through:
 *
 *   createContext()
 *   setGlobal('args', ...)        // structured clone of args
 *   setGlobal('ctx', ...)         // structured clone of ctx
 *   setGlobal('__syncActionInsert', new Reference(...))
 *   setGlobal('__syncActionUpdate', new Reference(...))
 *   setGlobal('__syncActionDelete', new Reference(...))
 *   setGlobal('__syncActionChange', new Reference(...))
 *   script.run(context)
 *
 * The Worker backend buries most of this in one postMessage round-trip;
 * the FFI backend does each as a synchronous FFI call. This script breaks
 * the per-call total apart so we can see which phase dominates → which
 * optimisation would actually move the warm-dispatch number.
 *
 * Run: bun run scripts/bench-sandbox-profile.ts
 */
import { createIsolate, Reference } from '@absolutejs/isolated-jsc';

const ITERATIONS = 200;
const WARMUP = 20;

type Phase = {
	name: string;
	totalMs: number;
	count: number;
};

const time = async <T>(
	phase: Phase,
	fn: () => Promise<T> | T
): Promise<T> => {
	const start = performance.now();
	const result = await fn();
	phase.totalMs += performance.now() - start;
	phase.count += 1;
	return result;
};

const noop = () => {};

const profile = async (backend: 'worker' | 'ffi') => {
	const isolate = await createIsolate({
		backend,
		memoryLimit: 1024
	});

	// Compile the wrapped script (same shape sandbox.ts emits).
	const script = await isolate.compileScript(`
		(async () => {
			const userFn = ((args) => args.n * 2);
			const actions = {
				insert: __syncActionInsert,
				update: __syncActionUpdate,
				delete: __syncActionDelete,
				change: __syncActionChange
			};
			return await userFn(args, ctx, actions);
		})()
	`);

	const phases: Record<string, Phase> = {
		createContext: { count: 0, name: 'createContext', totalMs: 0 },
		newReference: { count: 0, name: 'new Reference x4', totalMs: 0 },
		runScript: { count: 0, name: 'script.run', totalMs: 0 },
		setGlobalArgs: { count: 0, name: 'setGlobal args+ctx', totalMs: 0 },
		setGlobalRefs: { count: 0, name: 'setGlobal refs x4', totalMs: 0 }
	};

	for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
		const context = await time(phases.createContext!, () =>
			isolate.createContext()
		);

		await time(phases.setGlobalArgs!, async () => {
			await context.setGlobal('args', { n: i });
			await context.setGlobal('ctx', {});
		});

		const refs = await time(phases.newReference!, () => ({
			change: new Reference(noop),
			delete: new Reference(noop),
			insert: new Reference(noop),
			update: new Reference(noop)
		}));

		await time(phases.setGlobalRefs!, async () => {
			await context.setGlobal('__syncActionInsert', refs.insert);
			await context.setGlobal('__syncActionUpdate', refs.update);
			await context.setGlobal('__syncActionDelete', refs.delete);
			await context.setGlobal('__syncActionChange', refs.change);
		});

		await time(phases.runScript!, () => script.run(context));

		await context.dispose().catch(() => {});

		// Reset counters at end of warmup.
		if (i === WARMUP - 1) {
			for (const p of Object.values(phases)) {
				p.count = 0;
				p.totalMs = 0;
			}
		}
	}

	await isolate.dispose();

	const total = Object.values(phases).reduce((a, p) => a + p.totalMs, 0);
	console.log(
		`# ${backend.toUpperCase()} — ${ITERATIONS} warm iterations (per-call breakdown)`
	);
	console.log(
		`  Per-call total: ${(total / ITERATIONS).toFixed(2)} ms (${total.toFixed(0)} ms / ${ITERATIONS})`
	);
	for (const p of Object.values(phases)) {
		const perCall = p.totalMs / p.count;
		const pct = (p.totalMs / total) * 100;
		console.log(
			`    ${p.name.padEnd(28)} ${perCall.toFixed(3).padStart(7)} ms/call · ${pct.toFixed(1).padStart(5)}% of total`
		);
	}
	console.log('');
};

await profile('worker');
await profile('ffi');

process.exit(0);
