import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

type LiveTelephonyReport = {
  fixtures?: Array<{
    clearLatencyMs?: number;
    errors?: string[];
    firstOutboundMediaLatencyMs?: number;
    firstTurnLatencyMs?: number;
    markLatencyMs?: number;
    passes: boolean;
    termRecall?: number;
    wordErrorRate?: number;
  }>;
  generatedAt?: number;
  summary?: Record<string, unknown>;
  variant?: {
    description?: string;
    id?: string;
    model?: string;
  };
};

const variants = ["flux-general-en", "nova-3-phone"] as const;
const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const manifestPath = resolve(
  resultsDir,
  "telephony-live-shootout-manifest.json",
);
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await rm(manifestPath, { force: true });

const outputs: Array<{
  fixtureCount: number;
  modifiedAt: string;
  path: string;
  summary?: Record<string, unknown>;
  variant: string;
}> = [];

for (const variant of variants) {
  const outputPath = resolve(resultsDir, `telephony-live-${variant}.json`);
  await rm(outputPath, { force: true });

  const child = Bun.spawn({
    cmd: ["bun", "run", "./scripts/benchmark-live-telephony.ts", variant],
    cwd: projectRoot,
    env: {
      ...process.env,
      VOICE_TELEPHONY_LIVE_OUTPUT: outputPath,
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
      `Expected live telephony shootout output was not written: ${outputPath}`,
    );
  }

  const metadata = await stat(outputPath);
  if (metadata.mtimeMs < startedAt) {
    throw new Error(
      `Stale live telephony shootout output detected: ${outputPath}`,
    );
  }

  const parsed = (await file.json()) as LiveTelephonyReport;
  outputs.push({
    fixtureCount: Array.isArray(parsed.fixtures) ? parsed.fixtures.length : 0,
    modifiedAt: metadata.mtime.toISOString(),
    path: outputPath,
    summary: parsed.summary,
    variant,
  });
}

await Bun.write(
  manifestPath,
  JSON.stringify(
    {
      generatedAt: Date.now(),
      outputs,
    },
    null,
    2,
  ),
);

console.log(`Saved live telephony shootout manifest to ${manifestPath}`);
