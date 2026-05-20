import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

type BrowserDuplexOverlapSingleReport = {
  fixtures: Array<{
    adapterId: string;
    errors: string[];
    passes: boolean;
    turnPassRate: number;
    turns: Array<{
      audioChunkCount: number;
      firstAudioLatencyMs?: number;
      pass: boolean;
      playbackStopLatencyMs?: number;
      postInterruptAudioBytes: number;
      preInterruptAudioBytes: number;
      sessionCloseLatencyMs?: number;
      totalAudioBytes: number;
      turnId: string;
    }>;
  }>;
  generatedAt: number;
  summary: {
    averageFirstAudioLatencyMs?: number;
    averagePlaybackStopLatencyMs?: number;
    averageSessionCloseLatencyMs?: number;
    fixturePassCount: number;
    fixturePassRate: number;
    totalTurns: number;
    turnPassRate: number;
  };
};

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const runs = Number.parseInt(process.argv[2] ?? "3", 10);
const startedAt = Date.now();

if (!Number.isFinite(runs) || runs <= 0) {
  throw new Error(
    `Invalid browser duplex overlap series run count: ${process.argv[2] ?? ""}`,
  );
}

await mkdir(resultsDir, { recursive: true });

const descriptors = Array.from({ length: runs }, (_, runIndex) => {
  const runNumber = runIndex + 1;
  return [
    {
      adapterId: "elevenlabs",
      label: `duplex-browser-overlap-elevenlabs-series-run-${runNumber}`,
      outputPath: resolve(
        resultsDir,
        `duplex-browser-overlap-elevenlabs-series-run-${runNumber}.json`,
      ),
      runNumber,
    },
    {
      adapterId: "openai",
      label: `duplex-browser-overlap-openai-series-run-${runNumber}`,
      outputPath: resolve(
        resultsDir,
        `duplex-browser-overlap-openai-series-run-${runNumber}.json`,
      ),
      runNumber,
    },
  ];
}).flat();

const summaryPath = resolve(
  resultsDir,
  `duplex-browser-overlap-series-summary-runs-${runs}.json`,
);

await Promise.all(
  [summaryPath, ...descriptors.map((descriptor) => descriptor.outputPath)].map(
    (path) => rm(path, { force: true }),
  ),
);

for (const descriptor of descriptors) {
  console.log(`Running ${descriptor.label}`);
}

const children = descriptors.map((descriptor) =>
  Bun.spawn({
    cmd: [
      "bun",
      "run",
      "./scripts/benchmark-browser-duplex-overlap.ts",
      descriptor.adapterId,
      "--variant",
      `series-run-${descriptor.runNumber}`,
    ],
    cwd: projectRoot,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  }),
);

const exitCodes = await Promise.all(children.map((child) => child.exited));
const failed = exitCodes.find((code) => code !== 0);
if (typeof failed === "number") {
  process.exit(failed);
}

const outputs = await Promise.all(
  descriptors.map(async (descriptor) => {
    const file = Bun.file(descriptor.outputPath);
    if (!(await file.exists())) {
      throw new Error(
        `Expected browser duplex overlap series output was not written: ${descriptor.outputPath}`,
      );
    }

    const metadata = await stat(descriptor.outputPath);
    if (metadata.mtimeMs < startedAt) {
      throw new Error(
        `Stale browser duplex overlap series output detected: ${descriptor.outputPath}`,
      );
    }

    return {
      modifiedAt: metadata.mtime.toISOString(),
      outputPath: descriptor.outputPath,
      report: (await file.json()) as BrowserDuplexOverlapSingleReport,
      runNumber: descriptor.runNumber,
      target: descriptor.adapterId,
    };
  }),
);

const summarizeTarget = (target: string) => {
  const targetRuns = outputs.filter((output) => output.target === target);
  const fixtures = targetRuns
    .map((output) => output.report.fixtures[0])
    .filter((fixture): fixture is NonNullable<typeof fixture> =>
      Boolean(fixture),
    );
  const turns = fixtures.flatMap((fixture) => fixture.turns);
  const fixturePassCount = fixtures.filter((fixture) => fixture.passes).length;
  const passedTurns = turns.filter((turn) => turn.pass).length;
  const firstAudioSamples = turns.filter(
    (turn) => typeof turn.firstAudioLatencyMs === "number",
  );
  const playbackSamples = turns.filter(
    (turn) => typeof turn.playbackStopLatencyMs === "number",
  );
  const sessionCloseSamples = turns.filter(
    (turn) => typeof turn.sessionCloseLatencyMs === "number",
  );

  return {
    averageFirstAudioLatencyMs:
      firstAudioSamples.length > 0
        ? firstAudioSamples.reduce(
            (sum, turn) => sum + turn.firstAudioLatencyMs!,
            0,
          ) / firstAudioSamples.length
        : undefined,
    averagePlaybackStopLatencyMs:
      playbackSamples.length > 0
        ? playbackSamples.reduce(
            (sum, turn) => sum + turn.playbackStopLatencyMs!,
            0,
          ) / playbackSamples.length
        : undefined,
    averageSessionCloseLatencyMs:
      sessionCloseSamples.length > 0
        ? sessionCloseSamples.reduce(
            (sum, turn) => sum + turn.sessionCloseLatencyMs!,
            0,
          ) / sessionCloseSamples.length
        : undefined,
    fixturePassCount,
    fixturePassRate:
      fixtures.length > 0 ? fixturePassCount / fixtures.length : 0,
    runCount: fixtures.length,
    runs: targetRuns.map((output) => ({
      fixture: output.report.fixtures[0],
      modifiedAt: output.modifiedAt,
      outputPath: output.outputPath,
      runNumber: output.runNumber,
    })),
    stable: fixturePassCount === fixtures.length && fixtures.length > 0,
    totalTurns: turns.length,
    turnPassRate: turns.length > 0 ? passedTurns / turns.length : 0,
  };
};

const summary = {
  generatedAt: Date.now(),
  runs,
  targets: {
    elevenlabs: summarizeTarget("elevenlabs"),
    openai: summarizeTarget("openai"),
  },
};

await Bun.write(summaryPath, JSON.stringify(summary, null, 2));

const summaryMetadata = await stat(summaryPath);
if (summaryMetadata.mtimeMs < startedAt) {
  throw new Error(
    `Stale browser duplex overlap summary output detected: ${summaryPath}`,
  );
}

console.log(
  ["Saved browser duplex overlap series JSON to", summaryPath].join("\n"),
);
