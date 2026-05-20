import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runVoiceResilienceBenchmark } from "@absolutejs/voice/testing";

const BENCHMARK_RESULTS_DIR = resolve(
  import.meta.dir,
  "..",
  "benchmark-results",
);

const clearBenchmarkResultFamily = async (prefix: string) => {
  await mkdir(BENCHMARK_RESULTS_DIR, { recursive: true });

  for (const entry of await readdir(BENCHMARK_RESULTS_DIR)) {
    if (!entry.startsWith(`${prefix}-`) || !entry.endsWith(".json")) {
      continue;
    }

    await rm(resolve(BENCHMARK_RESULTS_DIR, entry), { force: true });
  }
};

const outputPath = resolve(BENCHMARK_RESULTS_DIR, "resilience-report.json");

const result = await runVoiceResilienceBenchmark();
await clearBenchmarkResultFamily("resilience");
await Bun.write(outputPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify(result, null, 2));
console.log(`\nSaved benchmark JSON to ${outputPath}`);
