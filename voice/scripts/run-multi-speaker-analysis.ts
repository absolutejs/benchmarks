const fixtureDir = process.env.VOICE_FIXTURE_DIR;

const sharedEnv = {
  ...process.env,
  ...(fixtureDir ? { VOICE_FIXTURE_DIR: fixtureDir } : {}),
};

const commands = [
  {
    label: "deepgram-multi-speaker-clean",
    proc: Bun.spawn(
      [
        "bun",
        "run",
        "./scripts/benchmark-stt.ts",
        "deepgram",
        "multi-speaker-clean",
      ],
      {
        cwd: import.meta.dir + "/..",
        env: sharedEnv,
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  },
  {
    label: "deepgram-multi-speaker-noisy",
    proc: Bun.spawn(
      [
        "bun",
        "run",
        "./scripts/benchmark-stt.ts",
        "deepgram",
        "multi-speaker-noisy",
      ],
      {
        cwd: import.meta.dir + "/..",
        env: sharedEnv,
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  },
  {
    label: "deepgram-multi-speaker-noisy-corrected",
    proc: Bun.spawn(
      [
        "bun",
        "run",
        "./scripts/benchmark-stt.ts",
        "deepgram-corrected",
        "multi-speaker-noisy",
      ],
      {
        cwd: import.meta.dir + "/..",
        env: sharedEnv,
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  },
  {
    label: "deepgram-multi-speaker-debug",
    proc: Bun.spawn(["bun", "run", "./scripts/run-multi-speaker-debug.ts"], {
      cwd: import.meta.dir + "/..",
      env: sharedEnv,
      stdout: "inherit",
      stderr: "inherit",
    }),
  },
];

const results = await Promise.all(
  commands.map(async ({ label, proc }) => ({ label, code: await proc.exited })),
);
const failures = results.filter((result) => result.code !== 0);

if (failures.length > 0) {
  throw new Error(
    `Multi-speaker analysis runner failed: ${failures
      .map((failure) => `${failure.label} exited ${failure.code}`)
      .join(", ")}`,
  );
}
