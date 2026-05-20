import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const outputPaths = [
  resolve(resultsDir, "duplex-browser-elevenlabs.json"),
  resolve(resultsDir, "duplex-browser-openai.json"),
];
const aggregatePath = resolve(resultsDir, "duplex-browser-all.json");
const manifestPath = resolve(resultsDir, "duplex-browser-run-manifest.json");
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await Promise.all(
  [...outputPaths, aggregatePath, manifestPath].map((path) =>
    rm(path, { force: true }),
  ),
);

const runs = [
  {
    args: ["bun", "run", "./scripts/benchmark-browser-duplex.ts", "elevenlabs"],
    label: "duplex-browser-elevenlabs",
    path: outputPaths[0],
  },
  {
    args: ["bun", "run", "./scripts/benchmark-browser-duplex.ts", "openai"],
    label: "duplex-browser-openai",
    path: outputPaths[1],
  },
];

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

const outputs = await Promise.all(
  runs.map(async (run) => {
    const file = Bun.file(run.path);
    if (!(await file.exists())) {
      throw new Error(
        `Expected browser duplex benchmark output was not written: ${run.path}`,
      );
    }

    const metadata = await stat(run.path);
    if (metadata.mtimeMs < startedAt) {
      throw new Error(
        `Stale browser duplex benchmark output detected: ${run.path}`,
      );
    }

    const parsed = (await file.json()) as {
      fixtures?: unknown[];
      generatedAt?: number;
      summary?: Record<string, unknown>;
    };

    return {
      fixtureCount: Array.isArray(parsed.fixtures) ? parsed.fixtures.length : 0,
      generatedAt: parsed.generatedAt,
      modifiedAt: metadata.mtime.toISOString(),
      path: run.path,
      summary: parsed.summary,
    };
  }),
);

const aggregate = {
  generatedAt: Date.now(),
  reports: await Promise.all(outputPaths.map((path) => Bun.file(path).json())),
};

await Bun.write(aggregatePath, JSON.stringify(aggregate, null, 2));
const aggregateMetadata = await stat(aggregatePath);
if (aggregateMetadata.mtimeMs < startedAt) {
  throw new Error(
    `Stale browser duplex benchmark output detected: ${aggregatePath}`,
  );
}

const manifest = {
  generatedAt: Date.now(),
  outputs: [
    ...outputs,
    {
      modifiedAt: aggregateMetadata.mtime.toISOString(),
      path: aggregatePath,
    },
  ],
};

await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
console.log(
  [
    "Saved browser duplex benchmark JSON to",
    ...outputPaths,
    aggregatePath,
    manifestPath,
  ].join("\n"),
);
