import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { deepgram } from "@absolutejs/voice-deepgram";
import { assemblyai } from "@absolutejs/voice-assemblyai";
import { openai } from "@absolutejs/voice-openai";
import { createRiskyTurnCorrectionHandler } from "@absolutejs/voice";
import { resolveVoiceRuntimePreset } from "@absolutejs/voice";
import { resolveVoiceSTTRoutingStrategy } from "@absolutejs/voice";
import {
  buildFixturePhraseHints,
  buildSessionCorrectionAudit,
  createBenchmarkCorrectionHandler,
  loadVoiceTestFixtures,
  runVoiceSessionBenchmark,
  runVoiceSessionBenchmarkSeries,
  type VoiceSessionBenchmarkScenario,
  type VoiceTestFixture,
} from "@absolutejs/voice/testing";
import type {
  AudioChunk,
  AudioFormat,
  RealtimeAdapter,
  STTAdapter,
  STTAdapterOpenOptions,
  STTAdapterSession,
  VoicePhraseHint,
} from "@absolutejs/voice";

const ENV_PATH = resolve(import.meta.dir, "..", ".env");
const BENCHMARK_RESULTS_DIR = resolve(
  import.meta.dir,
  "..",
  "benchmark-results",
);

type VoiceBenchEnv = {
  ASSEMBLYAI_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_RESPONSE_MODE?: "text" | "audio";
  OPENAI_TEST_MODELS?: string;
};

const normalizeTurnText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeEnvValue = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "undefined" || normalized === "null") {
    return undefined;
  }

  return trimmed;
};

const toUint8Array = (audio: AudioChunk): Uint8Array =>
  audio instanceof ArrayBuffer
    ? new Uint8Array(audio)
    : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);

const resamplePcm16Mono = (
  input: Uint8Array,
  sourceRate: number,
  targetRate: number,
): Uint8Array => {
  if (sourceRate === targetRate) {
    return input;
  }

  if (sourceRate <= 0 || targetRate <= 0) {
    return input;
  }

  const sourceSamples = new Int16Array(
    input.buffer,
    input.byteOffset,
    Math.floor(input.byteLength / 2),
  );
  const ratio = targetRate / sourceRate;
  const targetLength = Math.max(1, Math.round(sourceSamples.length * ratio));
  const output = new Int16Array(targetLength);

  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = index / ratio;
    const previousIndex = Math.floor(sourceIndex);
    const nextIndex = Math.min(previousIndex + 1, sourceSamples.length - 1);
    const fraction = sourceIndex - previousIndex;
    const previous = sourceSamples[previousIndex] ?? 0;
    const next = sourceSamples[nextIndex] ?? previous;
    output[index] = previous + (next - previous) * fraction;
  }

  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
};

const asRealtimeSTTAdapter = (adapter: RealtimeAdapter): STTAdapter => ({
  kind: "stt",
  open: async (options: STTAdapterOpenOptions): Promise<STTAdapterSession> => {
    const sourceFormat = options.format;
    if (sourceFormat.channels !== 1) {
      throw new Error(
        "OpenAI session benchmark resampler supports mono PCM only.",
      );
    }

    const normalizedFormat: AudioFormat = {
      ...sourceFormat,
      sampleRateHz: 24_000,
    };

    const session = await adapter.open({
      ...options,
      format: normalizedFormat,
    });

    return {
      close: (reason?: string) => session.close(reason),
      configure: (configuration) => session.configure?.(configuration) ?? Promise.resolve(),
      on: session.on,
      send: async (audio: AudioChunk) => {
        const input = toUint8Array(audio);
        const normalized = resamplePcm16Mono(
          input,
          sourceFormat.sampleRateHz,
          normalizedFormat.sampleRateHz,
        );
        await session.send(normalized);
      },
    };
  },
});

const resolveOpenAIModel = (env: VoiceBenchEnv): string | undefined => {
  const configured = (env.OPENAI_TEST_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((value): value is string => value.length > 0);

  return configured[0];
};

const clearBenchmarkResultFamily = async (prefix: string) => {
  await mkdir(BENCHMARK_RESULTS_DIR, { recursive: true });

  for (const entry of await readdir(BENCHMARK_RESULTS_DIR)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) {
      continue;
    }

    await rm(resolve(BENCHMARK_RESULTS_DIR, entry), { force: true });
  }
};

const buildSessionOutputStem = (
  target:
    | "all"
    | "best-stt"
    | "cheap-stt"
    | "deepgram"
    | "deepgram-hybrid"
    | "deepgram-corrected"
    | "deepgram-corrected-audit"
    | "deepgram-openai-hybrid"
    | "deepgram-flux"
    | "assemblyai"
    | "openai",
  profile: "baseline" | "soak",
) => `sessions-${target}${profile === "soak" ? "-soak" : ""}`;

const resolveOutputPath = (
  target:
    | "all"
    | "best-stt"
    | "cheap-stt"
    | "deepgram"
    | "deepgram-hybrid"
    | "deepgram-corrected"
    | "deepgram-corrected-audit"
    | "deepgram-openai-hybrid"
    | "deepgram-flux"
    | "assemblyai"
    | "openai",
  runs: number,
  profile: "baseline" | "soak",
  variant?: string,
) =>
  resolve(
    BENCHMARK_RESULTS_DIR,
    `${buildSessionOutputStem(target, profile)}${variant ? `-${variant}` : ""}${runs > 1 ? `-runs-${runs}` : ""}.json`,
  );

const parseEnv = async (): Promise<VoiceBenchEnv> => {
  const file = Bun.file(ENV_PATH);
  if (!(await file.exists())) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of (await file.text()).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    values[trimmed.slice(0, separatorIndex).trim()] = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }

  return {
    ASSEMBLYAI_API_KEY: normalizeEnvValue(values.ASSEMBLYAI_API_KEY),
    DEEPGRAM_API_KEY: normalizeEnvValue(values.DEEPGRAM_API_KEY),
    OPENAI_API_KEY: normalizeEnvValue(values.OPENAI_API_KEY),
    OPENAI_RESPONSE_MODE: normalizeEnvValue(values.OPENAI_RESPONSE_MODE) as
      | "text"
      | "audio"
      | undefined,
    OPENAI_TEST_MODELS: normalizeEnvValue(values.OPENAI_TEST_MODELS),
  };
};

const loadScenarios = async (
  correctionProfile?: "generic" | "benchmark-seeded",
): Promise<VoiceSessionBenchmarkScenario[]> => {
  const fixtures = await loadVoiceTestFixtures();
  const fixtureMap = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const quietlyFixture = fixtureMap.get("quietly-alone-clean");
  const chunkDurationMs = 80;
  const reconnectGapMs = 1_800;
  const reconnectAtChunkIndex =
    quietlyFixture !== undefined
      ? Math.ceil(
          quietlyFixture.audio.byteLength /
            Math.max(
              2,
              Math.floor(
                (quietlyFixture.format.sampleRateHz *
                  quietlyFixture.format.channels *
                  2 *
                  chunkDurationMs) /
                  1_000,
              ),
            ),
        ) + Math.ceil(reconnectGapMs / chunkDurationMs)
      : undefined;

  return fixtures
    .filter(
      (fixture) =>
        (fixture.tags ?? []).includes("dialogue-style") &&
        (fixture.expectedTurnTexts?.length ?? 0) > 0,
    )
    .map((fixture, index) => ({
      audioConditioning: {
        maxGain: 2.5,
        noiseGateAttenuation: 0,
        noiseGateThreshold: 0.004,
        targetLevel: 0.08,
      },
      ...fixture,
      chunkDurationMs,
      expectedTurnTexts: fixture.expectedTurnTexts ?? [],
      phraseHints: correctionProfile
        ? buildScenarioPhraseHints(fixture, correctionProfile)
        : undefined,
      reconnectAtChunkIndex: index === 0 ? reconnectAtChunkIndex : undefined,
      reconnectPauseMs: index === 0 ? 200 : undefined,
      silenceMs: 2_300,
      tailPaddingMs: 2_500,
      sttLifecycle: "turn-scoped",
      speechThreshold: 0.012,
      transcriptStabilityMs: 1_500,
      transcriptThreshold: 0.35,
      turnProfile: "long-form",
    }));
};

const createSilenceBytes = (sampleRateHz: number, durationMs: number) =>
  new Uint8Array(
    Math.max(2, Math.round((sampleRateHz * 2 * durationMs) / 1_000)),
  );

const concatAudioChunks = (chunks: Uint8Array[]) => {
  const totalByteLength = chunks.reduce(
    (sum, chunk) => sum + chunk.byteLength,
    0,
  );
  const output = new Uint8Array(totalByteLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
};

const buildReconnectChunkIndices = (input: {
  bytesPerChunk: number;
  gapByteLength: number;
  segmentByteLengths: number[];
}) => {
  const reconnectChunkIndices: number[] = [];
  let consumedBytes = 0;

  for (const [index, segmentByteLength] of input.segmentByteLengths.entries()) {
    consumedBytes += segmentByteLength;

    if (index === input.segmentByteLengths.length - 1) {
      continue;
    }

    const reconnectByteOffset =
      consumedBytes + Math.max(0, Math.floor(input.gapByteLength / 2));
    reconnectChunkIndices.push(
      Math.max(
        0,
        Math.ceil(reconnectByteOffset / Math.max(1, input.bytesPerChunk)) - 1,
      ),
    );
    consumedBytes += input.gapByteLength;
  }

  return reconnectChunkIndices;
};

const createSoakScenario = (input: {
  chunkDurationMs: number;
  correctionProfile?: "generic" | "benchmark-seeded";
  difficulty: "challenging" | "clean";
  fixtures: VoiceTestFixture[];
  id: string;
  reconnectPauseMsByIndex?: number[];
  silenceBetweenSegmentsMs: number;
  tags: string[];
  title: string;
}) => {
  const [baseFixture] = input.fixtures;
  if (!baseFixture) {
    throw new Error(
      `Unable to build soak scenario "${input.id}" without fixtures.`,
    );
  }

  const segmentByteLengths = input.fixtures.map(
    (fixture) => fixture.audio.byteLength,
  );
  const silenceChunk = createSilenceBytes(
    baseFixture.format.sampleRateHz,
    input.silenceBetweenSegmentsMs,
  );
  const audio = concatAudioChunks(
    input.fixtures.flatMap((fixture, index) =>
      index < input.fixtures.length - 1
        ? [fixture.audio, silenceChunk]
        : [fixture.audio],
    ),
  );
  const expectedTurnTexts = input.fixtures.flatMap(
    (fixture) => fixture.expectedTurnTexts ?? [],
  );
  const syntheticFixture: VoiceSessionBenchmarkScenario = {
    audio,
    audioConditioning: {
      maxGain: 2.7,
      noiseGateAttenuation: 0,
      noiseGateThreshold: input.difficulty === "challenging" ? 0.0035 : 0.004,
      targetLevel: 0.08,
    },
    audioPath: `${input.id}.pcm`,
    chunkDurationMs: input.chunkDurationMs,
    difficulty: input.difficulty,
    expectedText: expectedTurnTexts.join(" "),
    expectedTerms: [
      ...new Set(
        input.fixtures.flatMap((fixture) => fixture.expectedTerms ?? []),
      ),
    ],
    expectedTurnTexts,
    format: baseFixture.format,
    id: input.id,
    phraseHints: input.correctionProfile
      ? buildScenarioPhraseHints(
          {
            ...baseFixture,
            audio,
            audioPath: `${input.id}.pcm`,
            expectedText: expectedTurnTexts.join(" "),
            expectedTerms: [
              ...new Set(
                input.fixtures.flatMap(
                  (fixture) => fixture.expectedTerms ?? [],
                ),
              ),
            ],
            expectedTurnTexts,
            id: input.id,
            tags: input.tags,
            title: input.title,
          },
          input.correctionProfile,
        )
      : undefined,
    reconnectAtChunkIndices: buildReconnectChunkIndices({
      bytesPerChunk: Math.max(
        2,
        Math.floor(
          (baseFixture.format.sampleRateHz *
            baseFixture.format.channels *
            2 *
            input.chunkDurationMs) /
            1_000,
        ),
      ),
      gapByteLength: silenceChunk.byteLength,
      segmentByteLengths,
    }),
    reconnectPauseMsByIndex:
      input.reconnectPauseMsByIndex ??
      new Array(Math.max(0, input.fixtures.length - 1)).fill(220),
    silenceMs: 2_300,
    speechThreshold: 0.012,
    sttLifecycle: "turn-scoped",
    tags: input.tags,
    tailPaddingMs: 3_200,
    title: input.title,
    transcriptStabilityMs: 1_600,
    transcriptThreshold: 0.35,
    turnProfile: "long-form",
  };

  return syntheticFixture;
};

const loadSoakScenarios = async (
  correctionProfile?: "generic" | "benchmark-seeded",
): Promise<VoiceSessionBenchmarkScenario[]> => {
  const fixtures = await loadVoiceTestFixtures();
  const fixtureMap = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const requireFixture = (fixtureId: string) => {
    const fixture = fixtureMap.get(fixtureId);
    if (!fixture) {
      throw new Error(`Missing soak fixture "${fixtureId}".`);
    }

    return fixture;
  };
  const chunkDurationMs = 80;

  return [
    createSoakScenario({
      chunkDurationMs,
      correctionProfile,
      difficulty: "clean",
      fixtures: [
        requireFixture("dialogue-three-clean"),
        requireFixture("dialogue-two-clean"),
        requireFixture("dialogue-three-clean"),
      ],
      id: "soak-dialogue-clean-eight-turn",
      reconnectPauseMsByIndex: [180, 240],
      silenceBetweenSegmentsMs: 1_500,
      tags: [
        "clean",
        "dialogue-style",
        "long-session",
        "multi-turn",
        "reconnect-churn",
        "soak",
        "synthetic",
      ],
      title: "Soak clean dialogue with reconnect churn",
    }),
    createSoakScenario({
      chunkDurationMs,
      correctionProfile,
      difficulty: "challenging",
      fixtures: [
        requireFixture("dialogue-three-mixed"),
        requireFixture("dialogue-two-noisy"),
        requireFixture("dialogue-three-clean"),
      ],
      id: "soak-dialogue-mixed-eight-turn",
      reconnectPauseMsByIndex: [220, 320],
      silenceBetweenSegmentsMs: 1_700,
      tags: [
        "challenging",
        "dialogue-style",
        "long-session",
        "multi-turn",
        "noisy",
        "reconnect-churn",
        "soak",
        "synthetic",
      ],
      title: "Soak mixed dialogue with reconnect churn",
    }),
    createSoakScenario({
      chunkDurationMs,
      correctionProfile,
      difficulty: "challenging",
      fixtures: [
        requireFixture("dialogue-two-clean"),
        requireFixture("dialogue-three-mixed"),
        requireFixture("dialogue-two-noisy"),
        requireFixture("dialogue-three-clean"),
      ],
      id: "soak-dialogue-churn-ten-turn",
      reconnectPauseMsByIndex: [180, 260, 340],
      silenceBetweenSegmentsMs: 1_600,
      tags: [
        "challenging",
        "dialogue-style",
        "long-session",
        "multi-turn",
        "noisy",
        "reconnect-churn",
        "soak",
        "stress",
        "synthetic",
      ],
      title: "Soak ten-turn mixed dialogue with repeated reconnect churn",
    }),
  ];
};

const loadScenariosForTarget = async (input: {
  correctionProfile?: "generic" | "benchmark-seeded";
  profile: "baseline" | "soak";
}) =>
  input.profile === "soak"
    ? await loadSoakScenarios(input.correctionProfile)
    : await loadScenarios(input.correctionProfile);

const SESSION_KEYTERMS = [
  "quietly alone",
  "atlanta",
  "chattahoochee",
  "joe johnston",
  "rainstorms",
  "thatched trees",
  "well thatched trees",
  "shelter beneath",
];

const buildScenarioPhraseHints = (
  fixture: VoiceSessionBenchmarkScenario,
  profile: "generic" | "benchmark-seeded" = "benchmark-seeded",
): VoicePhraseHint[] => {
  return buildFixturePhraseHints(fixture, profile);
};

const applyRoutingStrategyToScenarios = (
  scenarios: VoiceSessionBenchmarkScenario[],
  strategy: ReturnType<typeof resolveVoiceSTTRoutingStrategy>,
  correctionProfile?: "generic" | "benchmark-seeded",
): VoiceSessionBenchmarkScenario[] => {
  const preset = resolveVoiceRuntimePreset(strategy.preset);

  return scenarios.map((scenario) => ({
    ...scenario,
    audioConditioning:
      preset.audioConditioning !== undefined
        ? {
            enabled: preset.audioConditioning.enabled,
            maxGain: preset.audioConditioning.maxGain,
            noiseGateAttenuation: preset.audioConditioning.noiseGateAttenuation,
            noiseGateThreshold: preset.audioConditioning.noiseGateThreshold,
            targetLevel: preset.audioConditioning.targetLevel,
          }
        : scenario.audioConditioning,
    phraseHints: correctionProfile
      ? buildScenarioPhraseHints(scenario, correctionProfile)
      : scenario.phraseHints,
    silenceMs: preset.turnDetection.silenceMs,
    speechThreshold: preset.turnDetection.speechThreshold,
    sttLifecycle: strategy.sttLifecycle,
    transcriptStabilityMs: preset.turnDetection.transcriptStabilityMs,
    turnProfile: preset.turnDetection.profile,
  }));
};

const createOpenAIFallbackAdapter = (env: VoiceBenchEnv): STTAdapter => {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in voice/.env");
  }

  return asRealtimeSTTAdapter(
    openai({
      apiKey: env.OPENAI_API_KEY,
      autoCommitSilenceMs: 700,
      inputTranscriptionLanguage: "en",
      inputTranscriptionModel: "gpt-4o-transcribe",
      inputTranscriptionPrompt: `Prioritize complete English recovery for noisy speech. Pay special attention to these phrases when heard: ${SESSION_KEYTERMS.join(", ")}.`,
      model: resolveOpenAIModel(env),
      noiseReduction: "far_field",
      responseMode: "text",
    }),
  );
};

const parseFixtureFilters = () => {
  const fixtureIds: string[] = [];

  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== "--fixture") {
      continue;
    }

    const fixtureId = process.argv[index + 1]?.trim();
    if (fixtureId) {
      fixtureIds.push(fixtureId);
    }
  }

  return [...new Set(fixtureIds)];
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const profileArgumentIndex = process.argv.findIndex(
    (value) => value === "--profile",
  );
  const profile =
    profileArgumentIndex >= 0 &&
    process.argv[profileArgumentIndex + 1] === "soak"
      ? "soak"
      : "baseline";
  const trace = process.argv.includes("--trace");
  const runsArgumentIndex = process.argv.findIndex(
    (value) => value === "--runs",
  );
  const runs =
    runsArgumentIndex >= 0 && process.argv[runsArgumentIndex + 1]
      ? Number(process.argv[runsArgumentIndex + 1])
      : 1;
  const variantArgumentIndex = process.argv.findIndex(
    (value) => value === "--variant",
  );
  const variant =
    variantArgumentIndex >= 0
      ? process.argv[variantArgumentIndex + 1]?.trim()
      : undefined;
  const deepgramModel = process.env.DEEPGRAM_MODEL ?? "nova-3";
  const fixtureFilters = parseFixtureFilters();
  const target = (process.argv[2] ?? "all") as
    | "all"
    | "best-stt"
    | "cheap-stt"
    | "deepgram"
    | "deepgram-hybrid"
    | "deepgram-corrected"
    | "deepgram-corrected-audit"
    | "deepgram-openai-hybrid"
    | "deepgram-flux"
    | "assemblyai"
    | "openai";
  const env = await parseEnv();
  const routingStrategy =
    target === "best-stt" || target === "cheap-stt"
      ? resolveVoiceSTTRoutingStrategy(
          target === "best-stt" ? "best" : "low-cost",
        )
      : undefined;
  const correctionProfileForTarget =
    target === "deepgram-corrected"
      ? "benchmark-seeded"
      : target === "best-stt"
        ? "generic"
        : undefined;
  let scenarios = (
    await loadScenariosForTarget({
      correctionProfile: correctionProfileForTarget,
      profile,
    })
  ).filter(
    (scenario) =>
      fixtureFilters.length === 0 || fixtureFilters.includes(scenario.id),
  );

  if (routingStrategy) {
    scenarios = applyRoutingStrategyToScenarios(
      scenarios,
      routingStrategy,
      correctionProfileForTarget,
    );
  }

  if (fixtureFilters.length > 0 && scenarios.length === 0) {
    throw new Error(
      `No session benchmark scenarios matched fixture filter(s): ${fixtureFilters.join(", ")}`,
    );
  }

  if (
    ![
      "all",
      "best-stt",
      "cheap-stt",
      "deepgram",
      "deepgram-hybrid",
      "deepgram-corrected",
      "deepgram-corrected-audit",
      "deepgram-openai-hybrid",
      "deepgram-flux",
      "assemblyai",
      "openai",
    ].includes(target)
  ) {
    throw new Error(
      `Unknown target "${target}". Expected all, best-stt, cheap-stt, deepgram, deepgram-hybrid, deepgram-corrected, deepgram-corrected-audit, deepgram-openai-hybrid, deepgram-flux, assemblyai, or openai.`,
    );
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          keysAvailable: {
            assemblyai: Boolean(env.ASSEMBLYAI_API_KEY),
            deepgram: Boolean(env.DEEPGRAM_API_KEY),
            openai: Boolean(env.OPENAI_API_KEY),
          },
          fixtureFilters,
          runs,
          scenarioCount: scenarios.length,
          target,
          variant,
          profile,
        },
        null,
        2,
      ),
    );
    return;
  }

  const runTarget = async (
    adapterId:
      | "best-stt"
      | "cheap-stt"
      | "deepgram"
      | "deepgram-hybrid"
      | "deepgram-corrected"
      | "deepgram-corrected-audit"
      | "deepgram-openai-hybrid"
      | "deepgram-flux"
      | "assemblyai"
      | "openai",
  ) => {
    const runBenchmark = async (
      adapter:
        | ReturnType<typeof deepgram>
        | ReturnType<typeof assemblyai>
        | STTAdapter,
    ) =>
      runs > 1
        ? await runVoiceSessionBenchmarkSeries({
            adapter,
            adapterId,
            runs,
            scenarios,
            trace,
          })
        : await runVoiceSessionBenchmark({
            adapter,
            adapterId,
            scenarios,
            trace,
          });

    if (adapterId === "deepgram") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
      }

      return await runBenchmark(
        deepgram({
          apiKey: env.DEEPGRAM_API_KEY,
          endpointing: false,
          interimResults: true,
          keyterms: SESSION_KEYTERMS,
          model: deepgramModel,
          punctuate: true,
          smartFormat: true,
          utteranceEndMs: 1500,
          vadEvents: true,
        }),
      );
    }

    if (adapterId === "deepgram-hybrid") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
      }

      if (!env.ASSEMBLYAI_API_KEY) {
        throw new Error(
          "Missing ASSEMBLYAI_API_KEY in voice/.env for deepgram-hybrid.",
        );
      }

      return await (runs > 1
        ? runVoiceSessionBenchmarkSeries({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            runs,
            scenarios,
            sttFallback: {
              adapter: assemblyai({
                apiKey: env.ASSEMBLYAI_API_KEY,
                endOfTurnConfidenceThreshold: 0.55,
                formatTurns: true,
                keytermsPrompt: SESSION_KEYTERMS,
                maxTurnSilence: 4_000,
                minEndOfTurnSilenceWhenConfident: 1_200,
                speechModel: "u3-rt-pro",
              }),
              completionTimeoutMs: 4_000,
              confidenceThreshold: 0.72,
              maxAttemptsPerTurn: 1,
              minTextLength: 2,
              replayWindowMs: 8_000,
              settleMs: 500,
              trigger: "always",
            },
            trace,
          })
        : runVoiceSessionBenchmark({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            scenarios,
            sttFallback: {
              adapter: assemblyai({
                apiKey: env.ASSEMBLYAI_API_KEY,
                endOfTurnConfidenceThreshold: 0.55,
                formatTurns: true,
                keytermsPrompt: SESSION_KEYTERMS,
                maxTurnSilence: 4_000,
                minEndOfTurnSilenceWhenConfident: 1_200,
                speechModel: "u3-rt-pro",
              }),
              completionTimeoutMs: 4_000,
              confidenceThreshold: 0.72,
              maxAttemptsPerTurn: 1,
              minTextLength: 2,
              replayWindowMs: 8_000,
              settleMs: 500,
              trigger: "always",
            },
            trace,
          }));
    }

    if (adapterId === "best-stt" || adapterId === "cheap-stt") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
      }

      const strategy = resolveVoiceSTTRoutingStrategy(
        adapterId === "best-stt" ? "best" : "low-cost",
      );
      const correctTurn =
        strategy.correctionMode === "generic"
          ? createBenchmarkCorrectionHandler("generic")
          : undefined;

      return await (runs > 1
        ? runVoiceSessionBenchmarkSeries({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            correctTurn,
            runs,
            scenarios,
            trace,
          })
        : runVoiceSessionBenchmark({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            correctTurn,
            scenarios,
            trace,
          }));
    }

    if (adapterId === "deepgram-corrected") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
      }

      const correctTurn = createBenchmarkCorrectionHandler("benchmark-seeded");

      return await (runs > 1
        ? runVoiceSessionBenchmarkSeries({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            correctTurn,
            runs,
            scenarios,
            trace,
          })
        : runVoiceSessionBenchmark({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            correctTurn,
            scenarios,
            trace,
          }));
    }

    if (adapterId === "deepgram-corrected-audit") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
      }

      if (runs > 1) {
        throw new Error(
          "deepgram-corrected-audit does not support --runs yet.",
        );
      }

      const genericScenarios = await loadScenariosForTarget({
        correctionProfile: "generic",
        profile,
      });
      const benchmarkSeededScenarios = await loadScenariosForTarget({
        correctionProfile: "benchmark-seeded",
        profile,
      });
      const createAdapter = () =>
        deepgram({
          apiKey: env.DEEPGRAM_API_KEY!,
          eotThreshold: 0.82,
          eotTimeoutMs: 1_200,
          keyterms: SESSION_KEYTERMS,
          model: "flux-general-en",
        });

      const raw = await runVoiceSessionBenchmark({
        adapter: createAdapter(),
        adapterId: "deepgram-flux",
        scenarios,
        trace,
      });
      const generic = await runVoiceSessionBenchmark({
        adapter: createAdapter(),
        adapterId: "deepgram-flux",
        correctTurn: createBenchmarkCorrectionHandler("generic"),
        scenarios: genericScenarios,
        trace,
      });
      const experimental = await runVoiceSessionBenchmark({
        adapter: createAdapter(),
        adapterId: "deepgram-flux",
        correctTurn: createRiskyTurnCorrectionHandler({
          riskTier: "balanced",
        }),
        scenarios: genericScenarios,
        trace,
      });
      const benchmarkSeeded = await runVoiceSessionBenchmark({
        adapter: createAdapter(),
        adapterId: "deepgram-flux",
        correctTurn: createBenchmarkCorrectionHandler("benchmark-seeded"),
        scenarios: benchmarkSeededScenarios,
        trace,
      });

      return buildSessionCorrectionAudit(
        raw,
        generic,
        experimental,
        benchmarkSeeded,
        benchmarkSeededScenarios,
      );
    }

    if (adapterId === "deepgram-openai-hybrid") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
      }

      if (!env.OPENAI_API_KEY) {
        throw new Error(
          "Missing OPENAI_API_KEY in voice/.env for deepgram-openai-hybrid.",
        );
      }

      return await (runs > 1
        ? runVoiceSessionBenchmarkSeries({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            runs,
            scenarios,
            sttFallback: {
              adapter: createOpenAIFallbackAdapter(env),
              completionTimeoutMs: 4_500,
              confidenceThreshold: 0.72,
              maxAttemptsPerTurn: 1,
              minTextLength: 2,
              replayWindowMs: 8_000,
              settleMs: 700,
              trigger: "always",
            },
            trace,
          })
        : runVoiceSessionBenchmark({
            adapter: deepgram({
              apiKey: env.DEEPGRAM_API_KEY,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: SESSION_KEYTERMS,
              model: "flux-general-en",
            }),
            adapterId,
            scenarios,
            sttFallback: {
              adapter: createOpenAIFallbackAdapter(env),
              completionTimeoutMs: 4_500,
              confidenceThreshold: 0.72,
              maxAttemptsPerTurn: 1,
              minTextLength: 2,
              replayWindowMs: 8_000,
              settleMs: 700,
              trigger: "always",
            },
            trace,
          }));
    }

    if (adapterId === "deepgram-flux") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
      }

      return await runBenchmark(
        deepgram({
          apiKey: env.DEEPGRAM_API_KEY,
          eotThreshold: 0.85,
          eotTimeoutMs: 1000,
          keyterms: SESSION_KEYTERMS,
          model: "flux-general-en",
        }),
      );
    }

    if (adapterId === "assemblyai") {
      if (!env.ASSEMBLYAI_API_KEY) {
        throw new Error("Missing ASSEMBLYAI_API_KEY in voice/.env");
      }

      return await runBenchmark(
        assemblyai({
          apiKey: env.ASSEMBLYAI_API_KEY,
          endOfTurnConfidenceThreshold: 0.55,
          formatTurns: true,
          keytermsPrompt: SESSION_KEYTERMS,
          maxTurnSilence: 4_000,
          minEndOfTurnSilenceWhenConfident: 1_200,
          speechModel: "u3-rt-pro",
        }),
      );
    }

    if (!env.OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY in voice/.env");
    }

    return await runBenchmark(
      asRealtimeSTTAdapter(
        openai({
          apiKey: env.OPENAI_API_KEY,
          autoCommitSilenceMs: 600,
          model: resolveOpenAIModel(env),
          responseMode: env.OPENAI_RESPONSE_MODE ?? "text",
        }),
      ),
    );
  };

  if (
    target === "best-stt" ||
    target === "cheap-stt" ||
    target === "deepgram" ||
    target === "deepgram-hybrid" ||
    target === "deepgram-corrected" ||
    target === "deepgram-corrected-audit" ||
    target === "deepgram-openai-hybrid" ||
    target === "deepgram-flux" ||
    target === "assemblyai" ||
    target === "openai"
  ) {
    const result = await runTarget(target);
    const outputPath = resolveOutputPath(target, runs, profile, variant);
    await clearBenchmarkResultFamily(
      `${buildSessionOutputStem(target, profile)}${variant ? `-${variant}` : ""}`,
    );
    await Bun.write(outputPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nSaved benchmark JSON to ${outputPath}`);
    return;
  }

  const result = await Promise.all([
    runTarget("deepgram"),
    runTarget("deepgram-hybrid"),
    runTarget("deepgram-corrected"),
    runTarget("deepgram-openai-hybrid"),
    runTarget("assemblyai"),
    runTarget("openai"),
  ]);
  const outputPath = resolveOutputPath(target, runs, profile, variant);
  await clearBenchmarkResultFamily(
    `${buildSessionOutputStem(target, profile)}${variant ? `-${variant}` : ""}`,
  );
  await Bun.write(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved benchmark JSON to ${outputPath}`);
};

await main();
