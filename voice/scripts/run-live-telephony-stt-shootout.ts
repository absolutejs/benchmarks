import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

type LiveTelephonyReport = {
  fixtures?: Array<{
    clearLatencyMs?: number;
    errors?: string[];
    firstOutboundMediaLatencyMs?: number;
    firstTurnLatencyMs?: number;
    markLatencyMs?: number;
    passes: boolean;
    termRecall?: number;
    wordErrorRate?: number;
  }>;
  summary?: {
    averageClearLatencyMs?: number;
    averageFirstOutboundMediaLatencyMs?: number;
    averageFirstTurnLatencyMs?: number;
    averageMarkLatencyMs?: number;
    averageTermRecall?: number;
    averageWordErrorRate?: number;
    passCount?: number;
    passRate?: number;
    totalOutboundMediaCount?: number;
  };
  trace?: Array<{
    atMs?: number;
    event?: string;
    source?: string;
  }>;
  ttsConfig?: {
    modelId?: string;
    optimizeStreamingLatency?: number;
    transport?: string;
    voiceSettings?: Record<string, unknown>;
  };
  turnDetectionConfig?: {
    silenceMs?: number;
    speechThreshold?: number;
    transcriptStabilityMs?: number;
  };
};

type ShootoutConfig = {
  id: string;
  env: Record<string, string>;
};

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const manifestPath = resolve(
  resultsDir,
  "telephony-live-stt-shootout-manifest.json",
);
const startedAt = Date.now();

const fixedTtsEnv = {
  VOICE_TELEPHONY_LIVE_TTS_MODEL: "eleven_flash_v2_5",
  VOICE_TELEPHONY_LIVE_TTS_OPTIMIZE: "4",
  VOICE_TELEPHONY_LIVE_TTS_SIMILARITY_BOOST: "0.7",
  VOICE_TELEPHONY_LIVE_TTS_STABILITY: "0.35",
  VOICE_TELEPHONY_LIVE_TTS_USE_SPEAKER_BOOST: "false",
  VOICE_TELEPHONY_LIVE_TTS_TRANSPORT: "http",
  VOICE_TELEPHONY_RESPONSE_MODE: "full",
} as const;

const configs: ShootoutConfig[] = [
  {
    env: {
      VOICE_TELEPHONY_LIVE_TURN_SILENCE_MS: "700",
      VOICE_TELEPHONY_LIVE_TRANSCRIPT_STABILITY_MS: "320",
    },
    id: "sil700-stab320",
  },
  {
    env: {
      VOICE_TELEPHONY_LIVE_TURN_SILENCE_MS: "620",
      VOICE_TELEPHONY_LIVE_TRANSCRIPT_STABILITY_MS: "280",
    },
    id: "sil620-stab280",
  },
  {
    env: {
      VOICE_TELEPHONY_LIVE_TURN_SILENCE_MS: "560",
      VOICE_TELEPHONY_LIVE_TRANSCRIPT_STABILITY_MS: "260",
    },
    id: "sil560-stab260",
  },
  {
    env: {
      VOICE_TELEPHONY_LIVE_TURN_SILENCE_MS: "520",
      VOICE_TELEPHONY_LIVE_TRANSCRIPT_STABILITY_MS: "220",
    },
    id: "sil520-stab220",
  },
  {
    env: {
      VOICE_TELEPHONY_LIVE_TURN_SILENCE_MS: "480",
      VOICE_TELEPHONY_LIVE_TRANSCRIPT_STABILITY_MS: "200",
    },
    id: "sil480-stab200",
  },
];

await mkdir(resultsDir, { recursive: true });
await rm(manifestPath, { force: true });

const outputs: Array<{
  configId: string;
  path: string;
  report: LiveTelephonyReport;
}> = [];

for (const config of configs) {
  const outputPath = resolve(
    resultsDir,
    `telephony-live-flux-general-en-stt-${config.id}.json`,
  );
  await rm(outputPath, { force: true });

  const child = Bun.spawn({
    cmd: [
      "bun",
      "run",
      "./scripts/benchmark-live-telephony.ts",
      "flux-general-en",
    ],
    cwd: projectRoot,
    env: {
      ...process.env,
      ...fixedTtsEnv,
      ...config.env,
      VOICE_TELEPHONY_LIVE_OUTPUT: outputPath,
      VOICE_TELEPHONY_VARIANT: "flux-general-en",
    },
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  const file = Bun.file(outputPath);
  if (!(await file.exists())) {
    throw new Error(
      `Expected live telephony STT output was not written: ${outputPath}`,
    );
  }

  const metadata = await stat(outputPath);
  if (metadata.mtimeMs < startedAt) {
    throw new Error(`Stale live telephony STT output detected: ${outputPath}`);
  }

  outputs.push({
    configId: config.id,
    path: outputPath,
    report: (await file.json()) as LiveTelephonyReport,
  });
}

const rank = outputs
  .map((entry) => {
    const fixture = entry.report.fixtures?.[0];
    return {
      configId: entry.configId,
      firstOutboundMediaLatencyMs: fixture?.firstOutboundMediaLatencyMs,
      firstTurnLatencyMs: fixture?.firstTurnLatencyMs,
      pass: fixture?.passes ?? false,
      path: entry.path,
      termRecall: fixture?.termRecall,
      traceCommitAt: entry.report.trace?.find((item) => item.event === "commit")
        ?.atMs,
      ttsConfig: entry.report.ttsConfig,
      turnDetectionConfig: entry.report.turnDetectionConfig,
      wordErrorRate: fixture?.wordErrorRate,
    };
  })
  .sort((left, right) => {
    const leftPass = left.pass ? 0 : 1;
    const rightPass = right.pass ? 0 : 1;
    if (leftPass !== rightPass) {
      return leftPass - rightPass;
    }

    return (
      (left.firstOutboundMediaLatencyMs ?? Number.POSITIVE_INFINITY) -
      (right.firstOutboundMediaLatencyMs ?? Number.POSITIVE_INFINITY)
    );
  });

await Bun.write(
  manifestPath,
  JSON.stringify(
    {
      generatedAt: Date.now(),
      outputs: rank,
    },
    null,
    2,
  ),
);

console.log(`Saved live telephony STT shootout manifest to ${manifestPath}`);
