import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const outputPaths = [
  resolve(resultsDir, "tts-all.json"),
  resolve(resultsDir, "tts-elevenlabs.json"),
  resolve(resultsDir, "tts-openai.json"),
];
const manifestPath = resolve(resultsDir, "tts-run-manifest.json");
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await Promise.all(
  [...outputPaths, manifestPath].map((path) => rm(path, { force: true })),
);

const runs = [
  {
    args: ["bun", "run", "./scripts/benchmark-tts.ts", "all"],
    label: "tts-all",
  },
  {
    args: ["bun", "run", "./scripts/benchmark-tts.ts", "elevenlabs"],
    label: "tts-elevenlabs",
  },
  {
    args: ["bun", "run", "./scripts/benchmark-tts.ts", "openai"],
    label: "tts-openai",
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

const manifest = {
  generatedAt: Date.now(),
  outputs: await Promise.all(
    outputPaths.map(async (path) => {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        throw new Error(
          `Expected TTS benchmark output was not written: ${path}`,
        );
      }

      const metadata = await stat(path);
      if (metadata.mtimeMs < startedAt) {
        throw new Error(`Stale TTS benchmark output detected: ${path}`);
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
  ["Saved TTS benchmark JSON to", ...outputPaths, manifestPath].join("\n"),
);
