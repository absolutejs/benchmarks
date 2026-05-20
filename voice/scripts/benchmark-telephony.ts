import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runVoiceTelephonyBenchmark } from "@absolutejs/voice/testing";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const outputPath = resolve(resultsDir, "telephony-twilio-bridge.json");
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await rm(outputPath, { force: true });

const report = await runVoiceTelephonyBenchmark();
await Bun.write(outputPath, JSON.stringify(report, null, 2));

const metadata = await stat(outputPath);
if (metadata.mtimeMs < startedAt) {
  throw new Error(`Stale telephony benchmark output detected: ${outputPath}`);
}

console.log(`Saved telephony benchmark JSON to ${outputPath}`);
