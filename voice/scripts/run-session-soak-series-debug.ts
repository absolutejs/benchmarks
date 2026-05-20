import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

type VoiceSessionBenchmarkTraceEntry = {
  atMs: number;
  data?: unknown;
  phase: string;
};

type VoiceSessionBenchmarkTurnResult = {
  actualText: string;
  expectedText?: string;
  index: number;
  passes: boolean;
};

type VoiceSessionBenchmarkScenarioResult = {
  actualTurns: string[];
  duplicateTurnCount: number;
  elapsedMs: number;
  expectedReconnectCount: number;
  expectedTurns: string[];
  fixtureId: string;
  passes: boolean;
  reconnectCount: number;
  title: string;
  turnCountDelta: number;
  turnPassRate: number;
  turnResults: VoiceSessionBenchmarkTurnResult[];
  trace?: VoiceSessionBenchmarkTraceEntry[];
};

type VoiceSessionBenchmarkReport = {
  adapterId: string;
  generatedAt: number;
  scenarios: VoiceSessionBenchmarkScenarioResult[];
  summary: {
    passCount: number;
    passRate: number;
  };
};

const projectRoot = resolve(import.meta.dir, "..");
const benchmarkResultsDir = resolve(projectRoot, "benchmark-results");
const target =
  process.argv[2] === "raw" ? "deepgram-flux" : "deepgram-corrected";
const targetLabel = target === "deepgram-corrected" ? "corrected" : "raw";
const fixtureIds = [
  "soak-dialogue-clean-eight-turn",
  "soak-dialogue-mixed-eight-turn",
  "soak-dialogue-churn-ten-turn",
];

await mkdir(benchmarkResultsDir, { recursive: true });

const runDescriptors = Array.from({ length: 3 }, (_, runIndex) =>
  fixtureIds.map((fixtureId) => ({
    fixtureId,
    outputName: `sessions-${target}-soak-${fixtureId}-series-debug-run-${runIndex + 1}.json`,
    runIndex,
  })),
).flat();

for (const run of runDescriptors) {
  console.log(
    `Running ${targetLabel} soak trace run ${run.runIndex + 1} for ${run.fixtureId}`,
  );
}

const children = runDescriptors.map((run) =>
  Bun.spawn({
    cmd: [
      "bun",
      "run",
      "./scripts/benchmark-session.ts",
      target,
      "--profile",
      "soak",
      "--trace",
      "--fixture",
      run.fixtureId,
      "--variant",
      `${run.fixtureId}-series-debug-run-${run.runIndex + 1}`,
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

const reports = await Promise.all(
  runDescriptors.map(async (run) => {
    const path = resolve(benchmarkResultsDir, run.outputName);
    return {
      fixtureId: run.fixtureId,
      path,
      report: (await Bun.file(path).json()) as VoiceSessionBenchmarkReport,
      runIndex: run.runIndex,
    };
  }),
);

const summary = {
  adapterId: target,
  generatedAt: Date.now(),
  runs: reports.map(({ fixtureId, path, report, runIndex }) => {
    const scenario = report.scenarios[0];
    if (!scenario) {
      throw new Error(`Missing scenario result in ${path}`);
    }

    return {
      actualTurns: scenario.actualTurns,
      duplicateTurnCount: scenario.duplicateTurnCount,
      elapsedMs: scenario.elapsedMs,
      expectedReconnectCount: scenario.expectedReconnectCount,
      expectedTurns: scenario.expectedTurns,
      fixtureId,
      outputPath: path,
      passes: scenario.passes,
      reconnectCount: scenario.reconnectCount,
      runIndex: runIndex + 1,
      summaryPassRate: report.summary.passRate,
      turnCountDelta: scenario.turnCountDelta,
      turnPassRate: scenario.turnPassRate,
      turnResults: scenario.turnResults,
      trace: scenario.trace ?? [],
    };
  }),
};

const summaryPath = resolve(
  benchmarkResultsDir,
  `session-soak-series-debug-summary-${targetLabel}.json`,
);
await Bun.write(summaryPath, JSON.stringify(summary, null, 2));

console.log(
  [
    "Saved benchmark JSON to",
    summaryPath,
    ...reports.map(({ path }) => path),
  ].join("\n"),
);
