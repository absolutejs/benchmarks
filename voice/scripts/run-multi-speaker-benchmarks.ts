const fixtureDir = process.env.VOICE_FIXTURE_DIR;

const sharedEnv = {
  ...process.env,
  ...(fixtureDir ? { VOICE_FIXTURE_DIR: fixtureDir } : {}),
};

const runs = [
  {
    label: "all",
    proc: Bun.spawn(
      ["bun", "run", "./scripts/benchmark-stt.ts", "all", "multi-speaker"],
      {
        cwd: import.meta.dir + "/..",
        env: sharedEnv,
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  },
  {
    label: "deepgram",
    proc: Bun.spawn(
      ["bun", "run", "./scripts/benchmark-stt.ts", "deepgram", "multi-speaker"],
      {
        cwd: import.meta.dir + "/..",
        env: sharedEnv,
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  },
];

const results = await Promise.all(
  runs.map(async ({ label, proc }) => ({ label, code: await proc.exited })),
);
const failures = results.filter((result) => result.code !== 0);

if (failures.length > 0) {
  throw new Error(
    `Multi-speaker benchmark runner failed: ${failures
      .map((failure) => `${failure.label} exited ${failure.code}`)
      .join(", ")}`,
  );
}
