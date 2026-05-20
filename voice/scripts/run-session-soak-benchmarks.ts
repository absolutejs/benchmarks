import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const benchmarkResultsDir = resolve(projectRoot, "benchmark-results");
const outputPaths = [
  resolve(benchmarkResultsDir, "sessions-deepgram-flux-soak-runs-3.json"),
  resolve(benchmarkResultsDir, "sessions-deepgram-corrected-soak-runs-3.json"),
  resolve(benchmarkResultsDir, "resilience-report.json"),
];
const manifestPath = resolve(
  benchmarkResultsDir,
  "session-soak-run-manifest.json",
);

const runs = [
  {
    args: [
      "bun",
      "run",
      "./scripts/benchmark-session.ts",
      "deepgram-flux",
      "--profile",
      "soak",
      "--runs",
      "3",
    ],
    label: "deepgram-flux-soak",
  },
  {
    args: [
      "bun",
      "run",
      "./scripts/benchmark-session.ts",
      "deepgram-corrected",
      "--profile",
      "soak",
      "--runs",
      "3",
    ],
    label: "deepgram-corrected-soak",
  },
  {
    args: ["bun", "run", "./scripts/benchmark-resilience.ts"],
    label: "resilience",
  },
];

await mkdir(benchmarkResultsDir, { recursive: true });
await Promise.all(
  [...outputPaths, manifestPath].map((path) => rm(path, { force: true })),
);
const startedAt = Date.now();

for (const run of runs) {
  console.log(`Running ${run.label}`);
}

const children = runs.map((run) =>
  Bun.spawn({
    cmd: run.args,
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

const manifest = {
  generatedAt: Date.now(),
  outputs: await Promise.all(
    outputPaths.map(async (path) => {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        throw new Error(
          `Expected soak benchmark output was not written: ${path}`,
        );
      }

      const metadata = await stat(path);
      if (metadata.mtimeMs < startedAt) {
        throw new Error(`Stale soak benchmark output detected: ${path}`);
      }

      const parsed = await file.json();
      return {
        generatedAt:
          parsed && typeof parsed === "object" && "generatedAt" in parsed
            ? (parsed.generatedAt as number | undefined)
            : undefined,
        modifiedAt: metadata.mtime.toISOString(),
        path,
      };
    }),
  ),
};

await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

console.log(
  ["Saved benchmark JSON to", ...outputPaths, manifestPath].join("\n"),
);
