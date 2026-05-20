import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const outputPath = resolve(resultsDir, "telephony-twilio-bridge.json");
const manifestPath = resolve(resultsDir, "telephony-run-manifest.json");
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await Promise.all(
  [outputPath, manifestPath].map((path) => rm(path, { force: true })),
);

const child = Bun.spawn({
  cmd: ["bun", "run", "./scripts/benchmark-telephony.ts"],
  cwd: projectRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

const exitCode = await child.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

const file = Bun.file(outputPath);
if (!(await file.exists())) {
  throw new Error(
    `Expected telephony benchmark output was not written: ${outputPath}`,
  );
}

const metadata = await stat(outputPath);
if (metadata.mtimeMs < startedAt) {
  throw new Error(`Stale telephony benchmark output detected: ${outputPath}`);
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
    },
  ],
};

await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
console.log(
  ["Saved telephony benchmark JSON to", outputPath, manifestPath].join("\n"),
);
