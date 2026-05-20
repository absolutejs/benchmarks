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
  reconnectTriggered: boolean;
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
};

const projectRoot = resolve(import.meta.dir, "..");
const benchmarkResultsDir = resolve(projectRoot, "benchmark-results");
const target =
  process.argv[2] === "corrected" ? "deepgram-corrected" : "deepgram-flux";
const targetLabel = target === "deepgram-corrected" ? "corrected" : "raw";

const runs = [
  {
    fixtureId: "soak-dialogue-clean-eight-turn",
    label: "clean",
    outputName: `sessions-${target}-soak-clean-debug.json`,
  },
  {
    fixtureId: "soak-dialogue-mixed-eight-turn",
    label: "mixed",
    outputName: `sessions-${target}-soak-mixed-debug.json`,
  },
  {
    fixtureId: "soak-dialogue-churn-ten-turn",
    label: "churn",
    outputName: `sessions-${target}-soak-churn-debug.json`,
  },
];

await mkdir(benchmarkResultsDir, { recursive: true });

for (const run of runs) {
  console.log(`Running ${targetLabel} soak debug for ${run.label}`);
}

const children = runs.map((run) =>
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
      `${run.label}-debug`,
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
  runs.map(async (run) => {
    const path = resolve(benchmarkResultsDir, run.outputName);
    return {
      path,
      report: (await Bun.file(path).json()) as VoiceSessionBenchmarkReport,
    };
  }),
);

const summary = {
  adapterId: target,
  generatedAt: Date.now(),
  scenarios: reports.map(({ path, report }) => {
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
      fixtureId: scenario.fixtureId,
      outputPath: path,
      passes: scenario.passes,
      reconnectCount: scenario.reconnectCount,
      turnCountDelta: scenario.turnCountDelta,
      turnPassRate: scenario.turnPassRate,
      turnResults: scenario.turnResults,
      trace: scenario.trace ?? [],
    };
  }),
};

const summaryPath = resolve(
  benchmarkResultsDir,
  `session-soak-debug-summary-${targetLabel}.json`,
);
await Bun.write(summaryPath, JSON.stringify(summary, null, 2));

console.log(
  [
    "Saved benchmark JSON to",
    summaryPath,
    ...reports.map(({ path }) => path),
  ].join("\n"),
);
