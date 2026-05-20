import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { deepgram } from "@absolutejs/voice-deepgram";
import { assemblyai } from "@absolutejs/voice-assemblyai";
import { openai } from "@absolutejs/voice-openai";
import type {
  AudioChunk,
  AudioFormat,
  RealtimeAdapter,
  STTAdapter,
  STTAdapterOpenOptions,
  STTAdapterSession,
} from "@absolutejs/voice";
import {
  evaluateSTTBenchmarkAcceptance,
  loadVoiceTestFixtures,
  applyCorrectedBenchmarkReport,
  buildCorrectionBenchmarkAudit,
  resolveFixtureEnvironment,
  runSTTAdapterBenchmark,
  summarizeSTTBenchmark,
  type VoiceSTTBenchmarkAcceptanceResult,
  type VoiceSTTBenchmarkAcceptanceThresholds,
  type VoiceSTTBenchmarkReport,
  type VoiceTestFixture,
} from "@absolutejs/voice/testing";

const ENV_PATH = resolve(import.meta.dir, "..", ".env");
const BENCHMARK_RESULTS_DIR = resolve(
  import.meta.dir,
  "..",
  "benchmark-results",
);

type VoiceBenchEnv = {
  ASSEMBLYAI_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_FLUX_MODEL?: string;
  DEEPGRAM_LANGUAGE?: string;
  DEEPGRAM_MODEL?: string;
  DEEPGRAM_NOISY_ENDPOINTING?: string;
  DEEPGRAM_NOISY_MODEL?: string;
  DEEPGRAM_NOISY_SETTLE_MS?: string;
  DEEPGRAM_NOISY_TAIL_PADDING_MS?: string;
  DEEPGRAM_NOISY_TRANSC_THRESHOLD?: string;
  DEEPGRAM_NOISY_UTTERANCE_END_MS?: string;
  DEEPGRAM_NOISY_VAD?: string;
  OPENAI_API_KEY?: string;
  OPENAI_RESPONSE_MODE?: "text" | "audio";
  OPENAI_TEST_MODELS?: string;
};

type BenchmarkTarget =
  | "all"
  | "deepgram"
  | "deepgram-nova"
  | "deepgram-flux"
  | "deepgram-corrected"
  | "deepgram-corrected-audit"
  | "deepgram-flux-noisy-room"
  | "assemblyai"
  | "openai";

type ProfileId = "accents" | "clean" | "noisy";

type ProfileDefinition = {
  harness: {
    idleTimeoutMs?: number;
    settleMs?: number;
    tailPaddingMs?: number;
    transcriptThreshold: number;
  };
  id: ProfileId;
  predicate: (fixture: VoiceTestFixture) => boolean;
  title: string;
};

type AdapterTarget = {
  id: string;
  adapter: (profile: ProfileDefinition) => STTAdapter;
  acceptance: VoiceSTTBenchmarkAcceptanceThresholds;
  postProcessReport?: (
    report: VoiceSTTBenchmarkReport,
    fixtures: VoiceTestFixture[],
  ) => VoiceSTTBenchmarkReport;
};

type AdapterBenchmarkProfileResult = {
  acceptance: VoiceSTTBenchmarkAcceptanceResult;
  profile: ProfileId;
  report: VoiceSTTBenchmarkReport;
};

type AdapterTargetFailure = {
  adapterId: string;
  error: string;
};

type AdapterSummarizeResult = {
  adapterId: string;
  failure?: AdapterTargetFailure;
  overall?: {
    acceptance: VoiceSTTBenchmarkAcceptanceResult;
    summary: {
      fixtureCount: number;
      passRate: number;
      wordAccuracyRate: number;
    };
  };
  profiles: AdapterBenchmarkProfileResult[];
};

type ProfileAcceptance = {
  acceptance: VoiceSTTBenchmarkAcceptanceResult;
  profile: ProfileId;
  report: VoiceSTTBenchmarkReport;
};

type CorrectionAuditSummary = {
  summary: VoiceSTTBenchmarkReport["summary"];
  acceptance: VoiceSTTBenchmarkAcceptanceResult;
};

type ProfileCorrectionAudit = {
  profile: ProfileId;
  raw: CorrectionAuditSummary;
  generic: CorrectionAuditSummary;
  benchmarkSeeded: CorrectionAuditSummary;
  holdout: {
    fixtureIds: string[];
    raw: CorrectionAuditSummary;
    generic: CorrectionAuditSummary;
    benchmarkSeeded: CorrectionAuditSummary;
  };
  lexicalHoldout: {
    fixtureIds: string[];
    raw: CorrectionAuditSummary;
    generic: CorrectionAuditSummary;
    benchmarkSeeded: CorrectionAuditSummary;
  };
};

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

const toNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
};

const toBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
};

const toDefinedEntries = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };

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
        "OpenAI production benchmark resampler supports mono PCM only.",
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

const parseEnv = async (): Promise<VoiceBenchEnv> => {
  const file = Bun.file(ENV_PATH);
  const values: Record<string, string> = {};
  const keys = Object.keys({
    ASSEMBLYAI_API_KEY: undefined,
    DEEPGRAM_API_KEY: undefined,
    DEEPGRAM_FLUX_MODEL: undefined,
    DEEPGRAM_LANGUAGE: undefined,
    DEEPGRAM_MODEL: undefined,
    DEEPGRAM_NOISY_ENDPOINTING: undefined,
    DEEPGRAM_NOISY_MODEL: undefined,
    DEEPGRAM_NOISY_SETTLE_MS: undefined,
    DEEPGRAM_NOISY_TAIL_PADDING_MS: undefined,
    DEEPGRAM_NOISY_TRANSC_THRESHOLD: undefined,
    DEEPGRAM_NOISY_UTTERANCE_END_MS: undefined,
    DEEPGRAM_NOISY_VAD: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_RESPONSE_MODE: undefined,
    OPENAI_TEST_MODELS: undefined,
  }) as Array<keyof VoiceBenchEnv>;

  if (await file.exists()) {
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
  }

  const readEnvValue = (key: keyof VoiceBenchEnv): string | undefined => {
    const value = process.env[key]?.trim();
    if (value && value.length > 0) {
      return normalizeEnvValue(value);
    }

    return normalizeEnvValue(values[key]);
  };

  return keys.reduce((acc, key) => {
    acc[key] = readEnvValue(key) as never;
    return acc;
  }, {} as VoiceBenchEnv);
};

const PROFILE_DEFINITIONS: Record<ProfileId, ProfileDefinition> = {
  accents: {
    harness: {
      idleTimeoutMs: 11_000,
      settleMs: 1_050,
      tailPaddingMs: 1_600,
      transcriptThreshold: 0.28,
    },
    id: "accents",
    predicate: (fixture) => {
      const group = resolveFixtureEnvironment(fixture);
      return group === "accent" || group === "accent-noisy";
    },
    title: "International accent stress",
  },
  clean: {
    harness: {
      idleTimeoutMs: 9_000,
      settleMs: 900,
      tailPaddingMs: 1_200,
      transcriptThreshold: 0.2,
    },
    id: "clean",
    predicate: (fixture) => {
      const group = resolveFixtureEnvironment(fixture);
      return group === "clean" || group === "other";
    },
    title: "Clean, low-noise utterances",
  },
  noisy: {
    harness: {
      idleTimeoutMs: 11_000,
      settleMs: 1_100,
      tailPaddingMs: 1_600,
      transcriptThreshold: 0.32,
    },
    id: "noisy",
    predicate: (fixture) => {
      const group = resolveFixtureEnvironment(fixture);
      return group === "noisy" || group === "accent-noisy";
    },
    title: "Noisy environment stress",
  },
};

const PROFILE_ACCEPTANCE: Record<
  ProfileId,
  VoiceSTTBenchmarkAcceptanceThresholds
> = {
  accents: {
    overallPassRate: 0.75,
    termRecall: 0.55,
    wordAccuracyRate: 0.65,
  },
  clean: {
    overallPassRate: 0.86,
    termRecall: 0.72,
    wordAccuracyRate: 0.8,
  },
  noisy: {
    overallPassRate: 0.74,
    termRecall: 0.5,
    wordAccuracyRate: 0.62,
  },
};

const OVERALL_ACCEPTANCE: VoiceSTTBenchmarkAcceptanceThresholds = {
  groupPassRate: {
    accents: {
      passRate: 0.75,
      wordAccuracyRate: 0.65,
    },
    "accent-noisy": {
      passRate: 0.67,
      wordAccuracyRate: 0.6,
    },
    clean: {
      passRate: 0.86,
      wordAccuracyRate: 0.8,
    },
    noisy: {
      passRate: 0.74,
      wordAccuracyRate: 0.62,
    },
    other: {
      passRate: 0.82,
      wordAccuracyRate: 0.75,
    },
  },
  overallPassRate: 0.8,
};

const resolveNoisyOverrides = (env: VoiceBenchEnv) =>
  toDefinedEntries({
    settleMs: toNumber(env.DEEPGRAM_NOISY_SETTLE_MS),
    tailPaddingMs: toNumber(env.DEEPGRAM_NOISY_TAIL_PADDING_MS),
    transcriptThreshold: toNumber(env.DEEPGRAM_NOISY_TRANSC_THRESHOLD),
  });

const resolveDeepgramNovaConfig = (env: VoiceBenchEnv) => ({
  connectTimeoutMs: 12_000,
  endpointing: false,
  interimResults: true,
  keyterms: ["help", "support", "issue", "problem"],
  language: env.DEEPGRAM_LANGUAGE ?? "en",
  model: env.DEEPGRAM_MODEL ?? "nova-3",
  punctuate: true,
  smartFormat: true,
  utteranceEndMs: 1_400,
  vadEvents: true,
});

const resolveDeepgramNoisyNovaConfig = (env: VoiceBenchEnv) =>
  toDefinedEntries({
    ...resolveDeepgramNovaConfig(env),
    endpointing:
      toBoolean(env.DEEPGRAM_NOISY_ENDPOINTING) ??
      (env.DEEPGRAM_NOISY_ENDPOINTING === undefined ? false : undefined),
    model: env.DEEPGRAM_NOISY_MODEL,
    utteranceEndMs:
      toNumber(env.DEEPGRAM_NOISY_UTTERANCE_END_MS) ??
      resolveDeepgramNovaConfig(env).utteranceEndMs,
    vadEvents:
      toBoolean(env.DEEPGRAM_NOISY_VAD) ??
      resolveDeepgramNovaConfig(env).vadEvents,
  });

const resolveDeepgramFluxConfig = (env: VoiceBenchEnv) => ({
  connectTimeoutMs: 12_000,
  eagerEotThreshold: 0.8,
  keyterms: ["help", "support", "issue", "problem"],
  model: env.DEEPGRAM_FLUX_MODEL ?? "flux-general-en",
});

const resolveDeepgramFluxNoisyRoomConfig = (env: VoiceBenchEnv) => ({
  ...resolveDeepgramFluxConfig(env),
  eagerEotThreshold: 0.74,
});

const resolveOpenAIModel = (env: VoiceBenchEnv): string | undefined => {
  const configured = (env.OPENAI_TEST_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((value): value is string => value.length > 0);

  return configured[0];
};

const applyCorrectedProductionReport = (
  report: VoiceSTTBenchmarkReport,
  fixtures: VoiceTestFixture[],
): VoiceSTTBenchmarkReport => applyCorrectedBenchmarkReport(report, fixtures);

const resolveAdapterTargets = (env: VoiceBenchEnv): AdapterTarget[] => {
  const targets: AdapterTarget[] = [];
  const deepgramNova = resolveDeepgramNovaConfig(env);
  const deepgramNovaNoisy = resolveDeepgramNoisyNovaConfig(env);
  const deepgramFlux = resolveDeepgramFluxConfig(env);
  const deepgramFluxNoisyRoom = resolveDeepgramFluxNoisyRoomConfig(env);

  if (env.DEEPGRAM_API_KEY) {
    targets.push({
      acceptance: OVERALL_ACCEPTANCE,
      adapter: (profile) =>
        deepgram({
          ...deepgramNova,
          ...(profile.id === "noisy" ? deepgramNovaNoisy : {}),
          apiKey: env.DEEPGRAM_API_KEY!,
        }),
      id: "deepgram-nova",
    });

    targets.push({
      acceptance: OVERALL_ACCEPTANCE,
      adapter: (profile) =>
        deepgram({
          ...deepgramFlux,
          apiKey: env.DEEPGRAM_API_KEY!,
          eotThreshold: 0.82,
          eotTimeoutMs:
            profile.id === "accents"
              ? 1_500
              : profile.id === "noisy"
                ? 1_200
                : 1_100,
        }),
      id: "deepgram-flux",
    });

    targets.push({
      acceptance: OVERALL_ACCEPTANCE,
      adapter: (profile) =>
        deepgram({
          ...deepgramFlux,
          apiKey: env.DEEPGRAM_API_KEY!,
          eotThreshold:
            profile.id === "accents"
              ? 0.82
              : profile.id === "noisy"
                ? 0.82
                : 0.8,
          eotTimeoutMs:
            profile.id === "accents"
              ? 1_500
              : profile.id === "noisy"
                ? 1_200
                : 1_100,
        }),
      id: "deepgram-corrected",
      postProcessReport: applyCorrectedProductionReport,
    });

    targets.push({
      acceptance: OVERALL_ACCEPTANCE,
      adapter: (profile) =>
        deepgram({
          ...deepgramFluxNoisyRoom,
          apiKey: env.DEEPGRAM_API_KEY!,
          eotThreshold:
            profile.id === "accents"
              ? 0.8
              : profile.id === "noisy"
                ? 0.74
                : 0.78,
          eotTimeoutMs:
            profile.id === "accents"
              ? 1_650
              : profile.id === "noisy"
                ? 1_600
                : 1_300,
        }),
      id: "deepgram-flux-noisy-room",
    });
  }

  if (env.ASSEMBLYAI_API_KEY) {
    targets.push({
      acceptance: OVERALL_ACCEPTANCE,
      adapter: () =>
        assemblyai({
          apiKey: env.ASSEMBLYAI_API_KEY!,
          endOfTurnConfidenceThreshold: 0.52,
          formatTurns: true,
          keytermsPrompt: ["help", "support", "issue", "problem"],
          maxTurnSilence: 4_000,
          minEndOfTurnSilenceWhenConfident: 1_100,
          speechModel: "u3-rt-pro",
        }),
      id: "assemblyai",
    });
  }

  if (env.OPENAI_API_KEY) {
    targets.push({
      acceptance: OVERALL_ACCEPTANCE,
      adapter: () =>
        asRealtimeSTTAdapter(
          openai({
            apiKey: env.OPENAI_API_KEY!,
            autoCommitSilenceMs: 600,
            model: resolveOpenAIModel(env),
            responseMode: env.OPENAI_RESPONSE_MODE ?? "text",
          }),
        ),
      id: "openai",
    });
  }

  return targets;
};

const formatPercent = (value: number | undefined) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "0.0%";
  }

  return `${(value * 100).toFixed(2)}%`;
};

const formatMs = (value: number | undefined) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return `${value.toFixed(0)}ms`;
};

const clearBenchmarkResultFamily = async (prefix: string) => {
  await mkdir(BENCHMARK_RESULTS_DIR, { recursive: true });

  for (const entry of await readdir(BENCHMARK_RESULTS_DIR)) {
    if (!entry.startsWith(`${prefix}-`) || !entry.endsWith(".json")) {
      continue;
    }

    await rm(resolve(BENCHMARK_RESULTS_DIR, entry), { force: true });
  }
};

const resolveOutputPath = (target: BenchmarkTarget, profileIds: ProfileId[]) =>
  resolve(
    BENCHMARK_RESULTS_DIR,
    `production-${target}-${profileIds.join("-")}.json`,
  );

const runProfile = async (
  profile: ProfileDefinition,
  fixtures: VoiceTestFixture[],
  adapterTarget: AdapterTarget,
  env: VoiceBenchEnv,
): Promise<ProfileAcceptance | null> => {
  const selectedFixtures = fixtures.filter(profile.predicate);
  if (selectedFixtures.length === 0) {
    return null;
  }

  const profileOptions = toDefinedEntries(
    profile.id === "noisy" ? resolveNoisyOverrides(env) : {},
  );

  const report = await runSTTAdapterBenchmark({
    adapter: adapterTarget.adapter(profile),
    adapterId: `${adapterTarget.id}-${profile.id}`,
    fixtures: selectedFixtures,
    options: {
      ...profile.harness,
      ...profileOptions,
    },
  });
  const normalizedReport = adapterTarget.postProcessReport
    ? adapterTarget.postProcessReport(report, selectedFixtures)
    : report;

  return {
    acceptance: evaluateSTTBenchmarkAcceptance(
      normalizedReport,
      PROFILE_ACCEPTANCE[profile.id],
    ),
    profile: profile.id,
    report: normalizedReport,
  };
};

const toProfileIds = (profiles: ProfileDefinition[]) =>
  profiles.map((profile) => profile.id);

const summarizeTarget = async (
  fixtures: VoiceTestFixture[],
  profiles: ProfileDefinition[],
  adapterTarget: AdapterTarget,
  env: VoiceBenchEnv,
): Promise<AdapterSummarizeResult> => {
  const profileResults: AdapterBenchmarkProfileResult[] = [];

  for (const profile of profiles) {
    try {
      const profileResult = await runProfile(
        profile,
        fixtures,
        adapterTarget,
        env,
      );
      if (profileResult) {
        profileResults.push(profileResult);
      }
    } catch (error) {
      return {
        adapterId: adapterTarget.id,
        failure: {
          adapterId: adapterTarget.id,
          error:
            error instanceof Error
              ? error.message
              : `Unknown error: ${String(error)}`,
        },
        profiles: [],
      };
    }
  }

  if (profileResults.length === 0) {
    return {
      adapterId: adapterTarget.id,
      failure: {
        adapterId: adapterTarget.id,
        error: `No fixtures matched profiles: ${toProfileIds(profiles).join(", ")}`,
      },
      profiles: [],
    };
  }

  const allFixtures = profileResults.flatMap(
    (result) => result.report.fixtures,
  );
  const overallReport: VoiceSTTBenchmarkReport = {
    adapterId: adapterTarget.id,
    fixtures: allFixtures,
    generatedAt: Date.now(),
    summary: summarizeSTTBenchmark(adapterTarget.id, allFixtures),
  };

  return {
    adapterId: adapterTarget.id,
    overall: {
      acceptance: evaluateSTTBenchmarkAcceptance(
        overallReport,
        adapterTarget.acceptance,
      ),
      summary: {
        fixtureCount: overallReport.summary.fixtureCount,
        passRate: overallReport.summary.passRate,
        wordAccuracyRate: overallReport.summary.wordAccuracyRate,
      },
    },
    profiles: profileResults,
  };
};

const summarizeCorrectionAudit = (
  report: VoiceSTTBenchmarkReport,
  thresholds: VoiceSTTBenchmarkAcceptanceThresholds,
): CorrectionAuditSummary => ({
  acceptance: evaluateSTTBenchmarkAcceptance(report, thresholds),
  summary: report.summary,
});

const buildProductionCorrectionAudit = async (
  fixtures: VoiceTestFixture[],
  profiles: ProfileDefinition[],
  env: VoiceBenchEnv,
) => {
  const deepgramTarget = resolveAdapterTargets(env).find(
    (adapter) => adapter.id === "deepgram-corrected",
  );
  if (!deepgramTarget) {
    throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
  }

  const profileAudits: ProfileCorrectionAudit[] = [];
  const rawReports: VoiceSTTBenchmarkReport[] = [];
  const genericReports: VoiceSTTBenchmarkReport[] = [];
  const benchmarkSeededReports: VoiceSTTBenchmarkReport[] = [];

  for (const profile of profiles) {
    const selectedFixtures = fixtures.filter(profile.predicate);
    if (selectedFixtures.length === 0) {
      continue;
    }

    const profileOptions = toDefinedEntries(
      profile.id === "noisy" ? resolveNoisyOverrides(env) : {},
    );
    const rawReport = await runSTTAdapterBenchmark({
      adapter: deepgramTarget.adapter(profile),
      adapterId: `deepgram-flux-${profile.id}`,
      fixtures: selectedFixtures,
      options: {
        ...profile.harness,
        ...profileOptions,
      },
    });
    const audit = buildCorrectionBenchmarkAudit(rawReport, selectedFixtures);

    rawReports.push(audit.raw);
    genericReports.push(audit.generic);
    benchmarkSeededReports.push(audit.benchmarkSeeded);

    profileAudits.push({
      benchmarkSeeded: summarizeCorrectionAudit(
        audit.benchmarkSeeded,
        PROFILE_ACCEPTANCE[profile.id],
      ),
      generic: summarizeCorrectionAudit(
        audit.generic,
        PROFILE_ACCEPTANCE[profile.id],
      ),
      holdout: {
        benchmarkSeeded: summarizeCorrectionAudit(
          audit.holdout.benchmarkSeeded,
          PROFILE_ACCEPTANCE[profile.id],
        ),
        fixtureIds: audit.holdout.fixtureIds,
        generic: summarizeCorrectionAudit(
          audit.holdout.generic,
          PROFILE_ACCEPTANCE[profile.id],
        ),
        raw: summarizeCorrectionAudit(
          audit.holdout.raw,
          PROFILE_ACCEPTANCE[profile.id],
        ),
      },
      lexicalHoldout: {
        benchmarkSeeded: summarizeCorrectionAudit(
          audit.lexicalHoldout.benchmarkSeeded,
          PROFILE_ACCEPTANCE[profile.id],
        ),
        fixtureIds: audit.lexicalHoldout.fixtureIds,
        generic: summarizeCorrectionAudit(
          audit.lexicalHoldout.generic,
          PROFILE_ACCEPTANCE[profile.id],
        ),
        raw: summarizeCorrectionAudit(
          audit.lexicalHoldout.raw,
          PROFILE_ACCEPTANCE[profile.id],
        ),
      },
      profile: profile.id,
      raw: summarizeCorrectionAudit(audit.raw, PROFILE_ACCEPTANCE[profile.id]),
    });
  }

  const combineReports = (
    adapterId: string,
    reports: VoiceSTTBenchmarkReport[],
  ): VoiceSTTBenchmarkReport => {
    const mergedFixtures = reports.flatMap((report) => report.fixtures);
    return {
      adapterId,
      fixtures: mergedFixtures,
      generatedAt: Date.now(),
      summary: summarizeSTTBenchmark(adapterId, mergedFixtures),
    };
  };

  const overallRaw = combineReports("deepgram-flux", rawReports);
  const overallGeneric = combineReports("deepgram-flux", genericReports);
  const overallBenchmarkSeeded = combineReports(
    "deepgram-flux",
    benchmarkSeededReports,
  );
  const holdoutFixtureIds = Array.from(
    new Set(profileAudits.flatMap((profile) => profile.holdout.fixtureIds)),
  );
  const sliceHoldout = (
    report: VoiceSTTBenchmarkReport,
  ): VoiceSTTBenchmarkReport => {
    const fixtureIdSet = new Set(holdoutFixtureIds);
    const matchedFixtures = report.fixtures.filter((fixture) =>
      fixtureIdSet.has(fixture.fixtureId),
    );

    return {
      adapterId: report.adapterId,
      fixtures: matchedFixtures,
      generatedAt: report.generatedAt,
      summary: summarizeSTTBenchmark(report.adapterId, matchedFixtures),
    };
  };
  const lexicalHoldoutFixtureIds = Array.from(
    new Set(
      profileAudits.flatMap((profile) => profile.lexicalHoldout.fixtureIds),
    ),
  );
  const sliceLexicalHoldout = (
    report: VoiceSTTBenchmarkReport,
  ): VoiceSTTBenchmarkReport => {
    const fixtureIdSet = new Set(lexicalHoldoutFixtureIds);
    const matchedFixtures = report.fixtures.filter((fixture) =>
      fixtureIdSet.has(fixture.fixtureId),
    );

    return {
      adapterId: report.adapterId,
      fixtures: matchedFixtures,
      generatedAt: report.generatedAt,
      summary: summarizeSTTBenchmark(report.adapterId, matchedFixtures),
    };
  };

  return {
    generatedAt: Date.now(),
    profileIds: profiles.map((profile) => profile.id),
    profiles: profileAudits,
    overall: {
      benchmarkSeeded: summarizeCorrectionAudit(
        overallBenchmarkSeeded,
        OVERALL_ACCEPTANCE,
      ),
      generic: summarizeCorrectionAudit(overallGeneric, OVERALL_ACCEPTANCE),
      holdout: {
        benchmarkSeeded: summarizeCorrectionAudit(
          sliceHoldout(overallBenchmarkSeeded),
          OVERALL_ACCEPTANCE,
        ),
        fixtureIds: holdoutFixtureIds,
        generic: summarizeCorrectionAudit(
          sliceHoldout(overallGeneric),
          OVERALL_ACCEPTANCE,
        ),
        raw: summarizeCorrectionAudit(
          sliceHoldout(overallRaw),
          OVERALL_ACCEPTANCE,
        ),
      },
      lexicalHoldout: {
        benchmarkSeeded: summarizeCorrectionAudit(
          sliceLexicalHoldout(overallBenchmarkSeeded),
          OVERALL_ACCEPTANCE,
        ),
        fixtureIds: lexicalHoldoutFixtureIds,
        generic: summarizeCorrectionAudit(
          sliceLexicalHoldout(overallGeneric),
          OVERALL_ACCEPTANCE,
        ),
        raw: summarizeCorrectionAudit(
          sliceLexicalHoldout(overallRaw),
          OVERALL_ACCEPTANCE,
        ),
      },
      raw: summarizeCorrectionAudit(overallRaw, OVERALL_ACCEPTANCE),
    },
  };
};

const main = async () => {
  const env = await parseEnv();
  const targetArg = (process.argv[2] ?? "all") as BenchmarkTarget;
  const profileArg = (process.argv[3] ?? "all") as ProfileId | "all";
  const profileIds: ProfileId[] =
    profileArg === "all" ? ["clean", "accents", "noisy"] : [profileArg];
  const profiles = profileIds.map((id) => PROFILE_DEFINITIONS[id]);

  if (
    ![
      "all",
      "deepgram",
      "deepgram-nova",
      "deepgram-flux",
      "deepgram-corrected",
      "deepgram-corrected-audit",
      "deepgram-flux-noisy-room",
      "assemblyai",
      "openai",
    ].includes(targetArg)
  ) {
    throw new Error(
      `Unknown target "${targetArg}". Expected all, deepgram, deepgram-nova, deepgram-flux, deepgram-corrected, deepgram-corrected-audit, deepgram-flux-noisy-room, assemblyai, or openai.`,
    );
  }

  const fixtures = await loadVoiceTestFixtures();
  if (targetArg === "deepgram-corrected-audit") {
    const output = await buildProductionCorrectionAudit(
      fixtures,
      profiles,
      env,
    );
    const outputPath = resolveOutputPath(targetArg, profileIds);
    await clearBenchmarkResultFamily("production");
    await Bun.write(outputPath, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
    console.log(`\nSaved benchmark JSON to ${outputPath}`);
    return;
  }
  const adapters = resolveAdapterTargets(env).filter((adapter) => {
    if (targetArg === "all") {
      return true;
    }

    if (targetArg === "deepgram") {
      return adapter.id.startsWith("deepgram");
    }

    return adapter.id === targetArg;
  });

  if (adapters.length === 0) {
    throw new Error(
      "Missing API keys in voice/.env. Set DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, or OPENAI_API_KEY.",
    );
  }

  const results = (
    await Promise.all(
      adapters.map((adapter) =>
        summarizeTarget(fixtures, profiles, adapter, env),
      ),
    )
  ).filter((entry) => entry.profiles.length > 0 || entry.failure);

  const output = {
    generatedAt: Date.now(),
    profileIds,
    results: results.map((entry) => ({
      adapterId: entry.adapterId,
      failure: entry.failure ?? null,
      overall: entry.overall
        ? {
            acceptance: entry.overall.acceptance,
            summary: entry.overall.summary,
          }
        : null,
      profiles: entry.profiles.map((profile) => ({
        acceptance: profile.acceptance,
        profile: profile.profile,
        summary: profile.report.summary,
      })),
    })),
  };

  const outputPath = resolveOutputPath(targetArg, profileIds);
  await clearBenchmarkResultFamily("production");
  await Bun.write(outputPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify(output, null, 2));
  console.log(`\nSaved benchmark JSON to ${outputPath}`);
  console.log("\nProduction readiness quick view");

  for (const entry of results) {
    if (entry.failure) {
      console.log(`${entry.adapterId}: ERROR ${entry.failure.error}`);
      continue;
    }

    if (!entry.overall) {
      console.log(`${entry.adapterId}: SKIP no successful profile runs`);
      continue;
    }

    const overallStatus = entry.overall.acceptance.passed ? "PASS" : "FAIL";
    console.log(
      `${entry.adapterId}: overall ${formatPercent(entry.overall.summary.passRate)} pass / ${formatPercent(entry.overall.summary.wordAccuracyRate)} accuracy / score ${(entry.overall.acceptance.score * 100).toFixed(1)} (${overallStatus})`,
    );

    for (const profile of entry.profiles) {
      const profileStatus = profile.acceptance.passed ? "PASS" : "FAIL";
      console.log(
        `  - ${profile.profile}: ${formatPercent(profile.report.summary.passRate)} pass / ${formatPercent(profile.report.summary.wordAccuracyRate)} accuracy / tail-final ${formatMs(profile.report.summary.averagePostSpeechTimeToFirstFinalMs)} / tail-eot ${formatMs(profile.report.summary.averagePostSpeechTimeToEndOfTurnMs)} / score ${(profile.acceptance.score * 100).toFixed(1)} (${profileStatus})`,
      );

      if (!profile.acceptance.passed) {
        for (const reason of profile.acceptance.failures) {
          console.log(`      -> ${reason}`);
        }
      }
    }
  }

  if (
    results.some(
      (result) =>
        result.failure || (result.overall && !result.overall.acceptance.passed),
    )
  ) {
    process.exitCode = 1;
  }
};

await main();
