import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const variant =
  process.argv[2] ?? process.env.VOICE_TELEPHONY_VARIANT ?? "flux-general-en";
const outputPath = resolve(
  resultsDir,
  variant === "flux-general-en"
    ? "telephony-live-deepgram-elevenlabs.json"
    : `telephony-live-${variant}.json`,
);
const manifestPath = resolve(
  resultsDir,
  variant === "flux-general-en"
    ? "telephony-live-run-manifest.json"
    : `telephony-live-run-manifest-${variant}.json`,
);
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await Promise.all(
  [outputPath, manifestPath].map((path) => rm(path, { force: true })),
);

const child = Bun.spawn({
  cmd: ["bun", "run", "./scripts/benchmark-live-telephony.ts", variant],
  cwd: projectRoot,
  env: {
    ...process.env,
    VOICE_TELEPHONY_VARIANT: variant,
  },
  stdio: ["inherit", "inherit", "inherit"],
});

const exitCode = await child.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

const file = Bun.file(outputPath);
if (!(await file.exists())) {
  throw new Error(
    `Expected live telephony benchmark output was not written: ${outputPath}`,
  );
}

const metadata = await stat(outputPath);
if (metadata.mtimeMs < startedAt) {
  throw new Error(
    `Stale live telephony benchmark output detected: ${outputPath}`,
  );
}

const parsed = (await file.json()) as {
  fixtures?: unknown[];
  generatedAt?: number;
  summary?: Record<string, unknown>;
};

const manifest = {
  generatedAt: Date.now(),
  outputs: [
    {
      fixtureCount: Array.isArray(parsed.fixtures) ? parsed.fixtures.length : 0,
      generatedAt: parsed.generatedAt,
      modifiedAt: metadata.mtime.toISOString(),
      path: outputPath,
      summary: parsed.summary,
      variant,
    },
  ],
};

await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
console.log(
  ["Saved live telephony benchmark JSON to", outputPath, manifestPath].join(
    "\n",
  ),
);
