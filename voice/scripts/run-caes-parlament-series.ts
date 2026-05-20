import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const defaultFixtureDir = resolve(
  projectRoot,
  "..",
  "..",
  "voice-fixtures-multilingual",
);

const sharedEnv = {
  ...process.env,
  DEEPGRAM_CODE_SWITCH_MODEL:
    process.env.DEEPGRAM_CODE_SWITCH_MODEL ?? "nova-3",
  DEEPGRAM_CODE_SWITCH_LANGUAGE:
    process.env.DEEPGRAM_CODE_SWITCH_LANGUAGE ?? "ca",
  VOICE_FIXTURE_DIR: process.env.VOICE_FIXTURE_DIR ?? defaultFixtureDir,
};

const runs = [
  {
    label: "raw",
    args: [
      "bun",
      "run",
      "./scripts/benchmark-stt.ts",
      "deepgram",
      "code-switch-ca-es-parlament",
      "--runs",
      "5",
    ],
  },
  {
    label: "corrected",
    args: [
      "bun",
      "run",
      "./scripts/benchmark-stt.ts",
      "deepgram-corrected",
      "code-switch-ca-es-parlament",
      "--runs",
      "5",
    ],
  },
];

for (const run of runs) {
  console.log(
    [
      `Running ${run.label} CA-ES parlament series`,
      `model=${sharedEnv.DEEPGRAM_CODE_SWITCH_MODEL}`,
      `language=${sharedEnv.DEEPGRAM_CODE_SWITCH_LANGUAGE}`,
      `fixtures=${sharedEnv.VOICE_FIXTURE_DIR}`,
    ].join(" "),
  );
}

const children = runs.map((run) =>
  Bun.spawn({
    cmd: run.args,
    cwd: projectRoot,
    env: sharedEnv,
    stdio: ["inherit", "inherit", "inherit"],
  }),
);

const exitCodes = await Promise.all(children.map((child) => child.exited));
const failed = exitCodes.find((code) => code !== 0);
if (typeof failed === "number") {
  process.exit(failed);
}

console.log(
  [
    "Saved benchmark JSON to",
    resolve(
      projectRoot,
      "benchmark-results",
      "stt-deepgram-code-switch-ca-es-parlament-series-5.json",
    ),
    "and",
    resolve(
      projectRoot,
      "benchmark-results",
      "stt-deepgram-corrected-code-switch-ca-es-parlament-series-5.json",
    ),
  ].join(" "),
);
