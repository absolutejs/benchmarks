import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const outputPaths = [
  resolve(resultsDir, "tts-all-interrupt.json"),
  resolve(resultsDir, "tts-elevenlabs-interrupt.json"),
  resolve(resultsDir, "tts-openai-interrupt.json"),
];
const manifestPath = resolve(resultsDir, "tts-interrupt-run-manifest.json");
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await Promise.all(
  [...outputPaths, manifestPath].map((path) => rm(path, { force: true })),
);

const runs = [
  {
    args: ["bun", "run", "./scripts/benchmark-tts.ts", "all", "interrupt"],
    label: "tts-all-interrupt",
  },
  {
    args: [
      "bun",
      "run",
      "./scripts/benchmark-tts.ts",
      "elevenlabs",
      "interrupt",
    ],
    label: "tts-elevenlabs-interrupt",
  },
  {
    args: ["bun", "run", "./scripts/benchmark-tts.ts", "openai", "interrupt"],
    label: "tts-openai-interrupt",
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
          `Expected TTS interruption benchmark output was not written: ${path}`,
        );
      }

      const metadata = await stat(path);
      if (metadata.mtimeMs < startedAt) {
        throw new Error(
          `Stale TTS interruption benchmark output detected: ${path}`,
        );
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
  [
    "Saved TTS interruption benchmark JSON to",
    ...outputPaths,
    manifestPath,
  ].join("\n"),
);
