import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const allowedVariants = new Set(["flux-general-en", "nova-3-phone"]);
type LiveTelephonyRunReport = {
  fixtures?: Array<{
    clearLatencyMs?: number;
    firstOutboundMediaLatencyMs?: number;
    firstTurnLatencyMs?: number;
    markLatencyMs?: number;
    passes: boolean;
    termRecall: number;
    wordErrorRate: number;
  }>;
  generatedAt?: number;
  summary?: {
    averageClearLatencyMs?: number;
    averageFirstOutboundMediaLatencyMs?: number;
    averageFirstTurnLatencyMs?: number;
    averageMarkLatencyMs?: number;
    averageTermRecall?: number;
    averageWordErrorRate?: number;
    passCount?: number;
    passRate?: number;
    totalOutboundMediaCount?: number;
  };
};

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const firstArg = process.argv[2];
const secondArg = process.argv[3];
const variant =
  firstArg && allowedVariants.has(firstArg)
    ? firstArg
    : (process.env.VOICE_TELEPHONY_VARIANT ?? "flux-general-en");
const runs = Number(
  firstArg && allowedVariants.has(firstArg)
    ? (secondArg ?? 3)
    : (firstArg ?? 3),
);
const manifestPath = resolve(
  resultsDir,
  variant === "flux-general-en"
    ? `telephony-live-series-summary-runs-${runs}.json`
    : `telephony-live-series-summary-${variant}-runs-${runs}.json`,
);
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await rm(manifestPath, { force: true });

const reports: Array<{
  path: string;
  report: LiveTelephonyRunReport;
  run: number;
}> = [];

for (let run = 1; run <= runs; run += 1) {
  const outputPath = resolve(
    resultsDir,
    variant === "flux-general-en"
      ? `telephony-live-deepgram-elevenlabs-run-${run}.json`
      : `telephony-live-${variant}-run-${run}.json`,
  );
  await rm(outputPath, { force: true });

  const child = Bun.spawn({
    cmd: ["bun", "run", "./scripts/benchmark-live-telephony.ts", variant],
    cwd: projectRoot,
    env: {
      ...process.env,
      VOICE_TELEPHONY_LIVE_OUTPUT: outputPath,
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
      `Expected live telephony output was not written: ${outputPath}`,
    );
  }

  const metadata = await stat(outputPath);
  if (metadata.mtimeMs < startedAt) {
    throw new Error(`Stale live telephony output detected: ${outputPath}`);
  }

  reports.push({
    path: outputPath,
    report: (await file.json()) as LiveTelephonyRunReport,
    run,
  });
}

const allFixtures = reports.flatMap((entry) =>
  (entry.report.fixtures ?? []).map((fixture) => ({
    ...fixture,
    run: entry.run,
  })),
);

const average = (values: number[]) =>
  values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const summary = {
  averageClearLatencyMs: average(
    allFixtures
      .map((fixture) => fixture.clearLatencyMs)
      .filter((value): value is number => typeof value === "number"),
  ),
  averageFirstOutboundMediaLatencyMs: average(
    allFixtures
      .map((fixture) => fixture.firstOutboundMediaLatencyMs)
      .filter((value): value is number => typeof value === "number"),
  ),
  averageFirstTurnLatencyMs: average(
    allFixtures
      .map((fixture) => fixture.firstTurnLatencyMs)
      .filter((value): value is number => typeof value === "number"),
  ),
  averageMarkLatencyMs: average(
    allFixtures
      .map((fixture) => fixture.markLatencyMs)
      .filter((value): value is number => typeof value === "number"),
  ),
  averageTermRecall:
    average(allFixtures.map((fixture) => fixture.termRecall)) ?? 0,
  averageWordErrorRate:
    average(allFixtures.map((fixture) => fixture.wordErrorRate)) ?? 0,
  passCount: allFixtures.filter((fixture) => fixture.passes).length,
  passRate:
    allFixtures.length > 0
      ? allFixtures.filter((fixture) => fixture.passes).length /
        allFixtures.length
      : 0,
  runCount: runs,
};

await Bun.write(
  manifestPath,
  JSON.stringify(
    {
      generatedAt: Date.now(),
      outputs: reports.map((entry) => ({
        path: entry.path,
        run: entry.run,
        summary: entry.report.summary,
      })),
      summary,
    },
    null,
    2,
  ),
);

console.log(`Saved live telephony series summary to ${manifestPath}`);
