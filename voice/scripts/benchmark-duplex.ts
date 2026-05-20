import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runVoiceDuplexBenchmark } from "@absolutejs/voice/testing";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const outputPath = resolve(resultsDir, "duplex-barge-in.json");
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await rm(outputPath, { force: true });

const report = await runVoiceDuplexBenchmark();
await Bun.write(outputPath, JSON.stringify(report, null, 2));

const metadata = await stat(outputPath);
if (metadata.mtimeMs < startedAt) {
  throw new Error(`Stale duplex benchmark output detected: ${outputPath}`);
}

console.log(`Saved duplex benchmark JSON to ${outputPath}`);
