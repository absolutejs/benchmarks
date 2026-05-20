import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const defaultFixtureDir = resolve(
  projectRoot,
  "..",
  "..",
  "voice-fixtures-multilingual",
);

const env = {
  ...process.env,
  DEEPGRAM_CODE_SWITCH_MODEL:
    process.env.DEEPGRAM_CODE_SWITCH_MODEL ?? "nova-3",
  DEEPGRAM_CODE_SWITCH_LANGUAGE:
    process.env.DEEPGRAM_CODE_SWITCH_LANGUAGE ?? "ca",
  VOICE_FIXTURE_DIR: process.env.VOICE_FIXTURE_DIR ?? defaultFixtureDir,
};

console.log(
  [
    "Running CA-ES corrected benchmark with Deepgram.",
    `model=${env.DEEPGRAM_CODE_SWITCH_MODEL}`,
    `language=${env.DEEPGRAM_CODE_SWITCH_LANGUAGE}`,
    `fixtures=${env.VOICE_FIXTURE_DIR}`,
  ].join(" "),
);

const child = Bun.spawn({
  cmd: [
    "bun",
    "run",
    "./scripts/benchmark-stt.ts",
    "deepgram-corrected",
    "code-switch-ca-es",
    "--runs",
    "5",
    "--variant",
    "nova3-ca-corrected",
  ],
  cwd: projectRoot,
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

const exitCode = await child.exited;

if (exitCode !== 0) {
  process.exit(exitCode);
}

const outputPath = resolve(
  projectRoot,
  "benchmark-results",
  "stt-deepgram-corrected-code-switch-ca-es-series-5-nova3-ca-corrected.json",
);

console.log(`Saved benchmark JSON to ${outputPath}`);
