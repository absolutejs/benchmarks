import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { deepgram } from "@absolutejs/voice-deepgram";
import { assemblyai } from "@absolutejs/voice-assemblyai";
import { openai } from "@absolutejs/voice-openai";
import {
  applyCorrectedBenchmarkReport,
  applyLexiconCorrectedBenchmarkReport,
  buildCodeSwitchBenchmarkLexicon,
  buildCodeSwitchBenchmarkPhraseHints,
  buildCorrectionBenchmarkAudit,
  compareSTTBenchmarks,
  createJargonVoiceTestFixtures,
  createMultiSpeakerVoiceTestFixtures,
  createTelephonyVoiceTestFixtures,
  loadVoiceTestFixtures,
  runSTTAdapterBenchmark,
  runSTTAdapterBenchmarkSeries,
  summarizeSTTBenchmarkSeries,
  type VoiceSTTBenchmarkReport,
} from "@absolutejs/voice/testing";
import type {
  AudioChunk,
  AudioFormat,
  RealtimeAdapter,
  STTAdapter,
  STTAdapterOpenOptions,
  VoiceLexiconEntry,
  VoiceLanguageStrategy,
  VoicePhraseHint,
  STTAdapterSession,
} from "@absolutejs/voice";

const ENV_PATH = resolve(import.meta.dir, "..", ".env");
const BENCHMARK_RESULTS_DIR = resolve(
  import.meta.dir,
  "..",
  "benchmark-results",
);

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

type VoiceBenchmarkMode = "normal" | "diagnostic";

type VoiceBenchEnv = {
  ASSEMBLYAI_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_CODE_SWITCH_LANGUAGE?: string;
  DEEPGRAM_CODE_SWITCH_MODEL?: string;
  DEEPGRAM_FLUX_MODEL?: string;
  DEEPGRAM_LANGUAGE?: string;
  DEEPGRAM_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_RESPONSE_MODE?: "text" | "audio";
  OPENAI_TEST_MODELS?: string;
};

type VoiceBenchmarkTarget =
  | "all"
  | "deepgram"
  | "deepgram-corrected"
  | "deepgram-corrected-audit"
  | "assemblyai"
  | "openai"
  | "openai-corrected";
type VoiceBenchmarkProfile =
  | "all"
  | "accents"
  | "baseline"
  | "code-switch"
  | "code-switch-ca-es"
  | "code-switch-ca-es-corts"
  | "code-switch-ca-es-parlament"
  | "code-switch-hi-en"
  | "jargon"
  | "multilingual"
  | "multi-speaker"
  | "multi-speaker-clean"
  | "multi-speaker-noisy"
  | "telephony";

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

const serializeDiagnosticError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: typeof error === "string" ? "Error" : "Unknown",
    message: typeof error === "string" ? error : "Non-error thrown",
  };
};

const asRealtimeSTTAdapter = (adapter: RealtimeAdapter): STTAdapter => ({
  kind: "stt",
  open: async (options: STTAdapterOpenOptions): Promise<STTAdapterSession> => {
    const sourceFormat = options.format;
    if (sourceFormat.channels !== 1) {
      throw new Error("OpenAI benchmark resampler supports mono PCM only.");
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
  const keys = Object.keys({
    ASSEMBLYAI_API_KEY: undefined,
    DEEPGRAM_API_KEY: undefined,
    DEEPGRAM_CODE_SWITCH_LANGUAGE: undefined,
    DEEPGRAM_CODE_SWITCH_MODEL: undefined,
    DEEPGRAM_FLUX_MODEL: undefined,
    DEEPGRAM_LANGUAGE: undefined,
    DEEPGRAM_MODEL: undefined,
    OPENAI_API_KEY: undefined,
  }) as Array<keyof VoiceBenchEnv>;
  const values: Record<string, string> = {};

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

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      values[key] = value;
    }
  }

  const read = (key: keyof VoiceBenchEnv): string | undefined => {
    const envValue = process.env[key]?.trim();
    if (envValue && envValue.length > 0) {
      return normalizeEnvValue(envValue);
    }

    return normalizeEnvValue(values[key]);
  };

  return keys.reduce((acc, key) => {
    acc[key] = read(key);
    return acc;
  }, {} as VoiceBenchEnv);
};

const resolveOpenAIModel = (env: VoiceBenchEnv): string | undefined => {
  const configured = (env.OPENAI_TEST_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((value): value is string => value.length > 0);

  return configured[0];
};

const clearBenchmarkResultStem = async (stem: string) => {
  await mkdir(BENCHMARK_RESULTS_DIR, { recursive: true });

  for (const entry of await readdir(BENCHMARK_RESULTS_DIR)) {
    if (!entry.startsWith(`${stem}`) || !entry.endsWith(".json")) {
      continue;
    }

    await rm(resolve(BENCHMARK_RESULTS_DIR, entry), { force: true });
  }
};

const buildResultStem = (
  target: VoiceBenchmarkTarget,
  profile: VoiceBenchmarkProfile,
  mode: VoiceBenchmarkMode,
  runs = 1,
  variant?: string,
) =>
  `${mode === "diagnostic" ? "stt-diagnostic" : "stt"}-${target}-${profile}${runs > 1 ? `-series-${runs}` : ""}${variant ? `-${variant}` : ""}`;

const resolveOutputPath = (
  target: VoiceBenchmarkTarget,
  profile: VoiceBenchmarkProfile,
  mode: VoiceBenchmarkMode,
  runs = 1,
  variant?: string,
) =>
  resolve(
    BENCHMARK_RESULTS_DIR,
    `${buildResultStem(target, profile, mode, runs, variant)}.json`,
  );

const resolveDeepgramModel = (env: VoiceBenchEnv) => {
  return env.DEEPGRAM_MODEL ?? "nova-3";
};

const isFluxModel = (model: string) => model.startsWith("flux");

const resolveDeepgramCodeSwitchLanguage = (
  env: VoiceBenchEnv,
  profile: VoiceBenchmarkProfile,
) => {
  const configured = normalizeLanguageCode(env.DEEPGRAM_CODE_SWITCH_LANGUAGE);
  if (configured) {
    return configured;
  }

  if (profile === "code-switch-ca-es") {
    return "ca";
  }

  if (
    profile === "code-switch-ca-es-corts" ||
    profile === "code-switch-ca-es-parlament"
  ) {
    return "ca";
  }

  return isCodeSwitchProfile(profile) ? "multi" : env.DEEPGRAM_LANGUAGE;
};

const normalizeLanguageCode = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const parseLanguageSegments = (value: string | undefined) => {
  const normalized = normalizeLanguageCode(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[-_,/]/)
    .map((segment) => segment.trim())
    .filter(
      (segment, index, list): segment is string =>
        segment.length > 0 && list.indexOf(segment) === index,
    );
};

const isCodeSwitchProfile = (profile: VoiceBenchmarkProfile) =>
  profile === "code-switch" ||
  profile === "code-switch-ca-es" ||
  profile === "code-switch-ca-es-corts" ||
  profile === "code-switch-ca-es-parlament" ||
  profile === "code-switch-hi-en";

const isMultiSpeakerProfile = (profile: VoiceBenchmarkProfile) =>
  profile === "multi-speaker" ||
  profile === "multi-speaker-clean" ||
  profile === "multi-speaker-noisy";

const resolveCodeSwitchPair = (profile: VoiceBenchmarkProfile) => {
  if (
    profile === "code-switch-ca-es" ||
    profile === "code-switch-ca-es-corts" ||
    profile === "code-switch-ca-es-parlament"
  ) {
    return "ca-es" as const;
  }

  if (profile === "code-switch-hi-en") {
    return "hi-en" as const;
  }

  return undefined;
};

const fixtureMatchesCodeSwitchPair = (
  fixture: {
    language?: string;
    tags?: string[];
  },
  pair: "ca-es" | "hi-en",
) => {
  const tags = new Set(
    (fixture.tags ?? []).map((tag) => tag.trim().toLowerCase()),
  );
  const normalizedLanguage = normalizeLanguageCode(fixture.language);
  const segments = parseLanguageSegments(fixture.language);
  const matchesLanguage =
    normalizedLanguage === pair ||
    (pair === "ca-es" &&
      segments.length >= 2 &&
      segments.includes("ca") &&
      segments.includes("es")) ||
    (pair === "hi-en" &&
      segments.length >= 2 &&
      segments.includes("hi") &&
      segments.includes("en"));

  if (matchesLanguage || tags.has(pair)) {
    return true;
  }

  if (pair === "ca-es") {
    return (
      tags.has("bsc") ||
      tags.has("bsc-lt") ||
      tags.has("bscs-code-switching-ca-es-asr-test")
    );
  }

  return tags.has("coshe") || tags.has("coshe-eval");
};

const fixtureHasNormalizedTag = (
  fixture: {
    tags?: string[];
  },
  targetTag: string,
) =>
  (fixture.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .includes(targetTag);

const resolveFixtureLanguageStrategy = (fixture: {
  language?: string;
  tags?: string[];
}): VoiceLanguageStrategy | undefined => {
  const tags = new Set(fixture.tags ?? []);
  const segments = parseLanguageSegments(fixture.language);

  if (tags.has("code-switch") || tags.has("code_switch")) {
    if (segments.length >= 2) {
      return {
        mode: "allow-switching",
        primaryLanguage: segments[0],
        secondaryLanguages: segments.slice(1),
      };
    }

    return {
      mode: "auto-detect",
    };
  }

  if (segments.length === 0) {
    return undefined;
  }

  return {
    mode: "fixed",
    primaryLanguage: segments[0],
    secondaryLanguages: segments.slice(1),
  };
};

const buildBenchmarkOpenOptions =
  (
    profile: VoiceBenchmarkProfile,
  ): ((fixture: {
    language?: string;
    tags?: string[];
  }) => Partial<STTAdapterOpenOptions> | undefined) =>
  (fixture) => {
    if (profile !== "multilingual" && !isCodeSwitchProfile(profile)) {
      return undefined;
    }

    const languageStrategy = resolveFixtureLanguageStrategy(fixture);
    if (!languageStrategy) {
      return undefined;
    }

    return {
      languageStrategy,
    };
  };

const buildBenchmarkLexicon =
  (
    profile: VoiceBenchmarkProfile,
  ): ((fixture: {
    expectedText?: string;
    language?: string;
    tags?: string[];
  }) => VoiceLexiconEntry[] | undefined) =>
  (fixture) => {
    if (!isCodeSwitchProfile(profile)) {
      return undefined;
    }

    const entries = buildCodeSwitchBenchmarkLexicon(fixture);
    return entries.length > 0 ? entries : undefined;
  };

const buildBenchmarkPhraseHints =
  (
    profile: VoiceBenchmarkProfile,
  ): ((fixture: {
    expectedText?: string;
    expectedTerms?: string[];
    language?: string;
  }) => VoicePhraseHint[] | undefined) =>
  (fixture) => {
    if (!isCodeSwitchProfile(profile)) {
      return undefined;
    }

    const entries = buildCodeSwitchBenchmarkPhraseHints(fixture);
    return entries.length > 0 ? entries : undefined;
  };

const withCorrectedAdapterId = (
  adapterId: string,
  report: VoiceSTTBenchmarkReport,
): VoiceSTTBenchmarkReport => ({
  ...report,
  adapterId,
  summary: {
    ...report.summary,
    adapterId,
  },
});

const applyTargetCorrections = (
  target: "deepgram-corrected" | "openai-corrected",
  profile: VoiceBenchmarkProfile,
  report: VoiceSTTBenchmarkReport,
  fixtures: Awaited<ReturnType<typeof filterFixturesForProfile>>,
) => {
  if (isCodeSwitchProfile(profile)) {
    return withCorrectedAdapterId(
      target,
      applyLexiconCorrectedBenchmarkReport(
        report,
        fixtures,
        buildCodeSwitchBenchmarkLexicon,
      ),
    );
  }

  if (target === "deepgram-corrected") {
    return withCorrectedAdapterId(
      target,
      applyCorrectedBenchmarkReport(report, fixtures),
    );
  }

  return withCorrectedAdapterId(target, report);
};

const buildOpenAIBenchmarkConfig = (
  env: VoiceBenchEnv,
  profile: VoiceBenchmarkProfile,
) => {
  const responseMode =
    (process.env.OPENAI_RESPONSE_MODE as "text" | "audio" | undefined) ??
    "text";
  const codeSwitchPair = resolveCodeSwitchPair(profile);
  const inputTranscriptionPrompt = isCodeSwitchProfile(profile)
    ? [
        codeSwitchPair === "ca-es"
          ? "The speaker may switch between Catalan and Spanish within the same utterance."
          : codeSwitchPair === "hi-en"
            ? "The speaker may switch between Hindi and English within the same utterance."
            : "The speaker may switch between Hindi and English or Catalan and Spanish within the same utterance.",
        "Preserve code-switching verbatim instead of normalizing everything into one language.",
        "Do not translate.",
        codeSwitchPair === "hi-en"
          ? "Do not transliterate Devanagari into Latin or Latin into Devanagari."
          : "Keep original script and diacritics intact.",
        "Keep accents, apostrophes, mixed-language phrases, and named entities exactly as spoken.",
        codeSwitchPair === "ca-es"
          ? "If a short Spanish term appears inside a Catalan sentence or a short Catalan term appears inside a Spanish sentence, keep the language switch."
          : codeSwitchPair === "hi-en"
            ? "If a short English term appears inside a Hindi sentence or a short Hindi term appears inside an English sentence, keep the language switch."
            : "If a short English term appears inside a Hindi sentence or a short Spanish term appears inside a Catalan sentence, keep the language switch.",
      ].join(" ")
    : undefined;

  return {
    apiKey: env.OPENAI_API_KEY!,
    autoCommitSilenceMs: 600,
    inputTranscriptionPrompt,
    model: resolveOpenAIModel(env),
    responseMode,
  };
};

const parseRuns = () => {
  const runFlagIndex = process.argv.findIndex((entry) => entry === "--runs");
  if (runFlagIndex === -1) {
    return 1;
  }

  const value = Number.parseInt(process.argv[runFlagIndex + 1] ?? "", 10);
  return Number.isFinite(value) && value > 1 ? value : 1;
};

const parseVariant = () => {
  const flagIndex = process.argv.findIndex(
    (entry) => entry === "--variant" || entry === "--label",
  );
  if (flagIndex === -1) {
    return undefined;
  }

  const value = process.argv[flagIndex + 1]?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  return value.replace(/[^a-z0-9._-]+/g, "-");
};

const matchesMultilingualProfile = (fixture: {
  language?: string;
  tags?: string[];
}) => {
  const tags = new Set(fixture.tags ?? []);
  const language = fixture.language?.trim().toLowerCase();

  return (
    tags.has("multilingual") ||
    tags.has("bilingual") ||
    tags.has("code-switch") ||
    tags.has("code_switch") ||
    (typeof language === "string" &&
      language.length > 0 &&
      !language.startsWith("en"))
  );
};

const filterFixturesForProfile = async (profile: VoiceBenchmarkProfile) => {
  const baseFixtures = await loadVoiceTestFixtures();

  if (profile === "telephony") {
    return createTelephonyVoiceTestFixtures(baseFixtures);
  }

  if (profile === "multi-speaker") {
    return createMultiSpeakerVoiceTestFixtures(baseFixtures);
  }

  if (profile === "multi-speaker-clean") {
    return createMultiSpeakerVoiceTestFixtures(baseFixtures).filter((fixture) =>
      (fixture.tags ?? []).includes("clean"),
    );
  }

  if (profile === "multi-speaker-noisy") {
    return createMultiSpeakerVoiceTestFixtures(baseFixtures).filter((fixture) =>
      (fixture.tags ?? []).includes("noisy"),
    );
  }

  if (profile === "jargon") {
    return createJargonVoiceTestFixtures(baseFixtures);
  }

  return baseFixtures.filter((fixture) => {
    const tags = fixture.tags ?? [];
    if (profile === "accents") {
      return tags.includes("accent");
    }

    if (profile === "baseline") {
      return !tags.includes("accent") && !matchesMultilingualProfile(fixture);
    }

    if (profile === "code-switch") {
      return tags.includes("code-switch") || tags.includes("code_switch");
    }

    if (profile === "code-switch-ca-es") {
      return (
        (tags.includes("code-switch") || tags.includes("code_switch")) &&
        fixtureMatchesCodeSwitchPair(fixture, "ca-es")
      );
    }

    if (profile === "code-switch-ca-es-corts") {
      return (
        (tags.includes("code-switch") || tags.includes("code_switch")) &&
        fixtureMatchesCodeSwitchPair(fixture, "ca-es") &&
        fixtureHasNormalizedTag(fixture, "corts_valencianes_anonymized")
      );
    }

    if (profile === "code-switch-ca-es-parlament") {
      return (
        (tags.includes("code-switch") || tags.includes("code_switch")) &&
        fixtureMatchesCodeSwitchPair(fixture, "ca-es") &&
        fixtureHasNormalizedTag(fixture, "parlament_parla")
      );
    }

    if (profile === "code-switch-hi-en") {
      return (
        (tags.includes("code-switch") || tags.includes("code_switch")) &&
        fixtureMatchesCodeSwitchPair(fixture, "hi-en")
      );
    }

    if (profile === "multilingual") {
      return matchesMultilingualProfile(fixture);
    }

    return true;
  });
};

const buildMissingProfileError = (profile: VoiceBenchmarkProfile) => {
  if (profile !== "multilingual" && !isCodeSwitchProfile(profile)) {
    if (profile === "multi-speaker") {
      return 'No fixtures matched benchmark profile "multi-speaker".';
    }

    if (
      profile === "multi-speaker-clean" ||
      profile === "multi-speaker-noisy"
    ) {
      return `No fixtures matched benchmark profile "${profile}".`;
    }

    return `No fixtures matched benchmark profile "${profile}".`;
  }

  return [
    `No fixtures matched benchmark profile "${profile}".`,
    "Add multilingual or code-switch fixtures via VOICE_FIXTURE_DIR or VOICE_FIXTURE_DIRS.",
    "Each external fixture directory must include manifest.json and pcm/*.pcm entries.",
  ].join(" ");
};

const loadReport = async (
  target:
    | "deepgram"
    | "deepgram-corrected"
    | "deepgram-corrected-audit"
    | "assemblyai"
    | "openai"
    | "openai-corrected",
  profile: VoiceBenchmarkProfile,
  env: VoiceBenchEnv,
): Promise<VoiceSTTBenchmarkReport | null> => {
  const fixtures = await filterFixturesForProfile(profile);

  if (fixtures.length === 0) {
    throw new Error(buildMissingProfileError(profile));
  }

  if (
    target === "deepgram" ||
    target === "deepgram-corrected" ||
    target === "deepgram-corrected-audit"
  ) {
    if (!env.DEEPGRAM_API_KEY) {
      return null;
    }

    const model = resolveDeepgramModel(env);
    const codeSwitchProfile = isCodeSwitchProfile(profile);
    const multiSpeakerProfile = isMultiSpeakerProfile(profile);
    const useMultilingualConfig =
      profile === "multilingual" || codeSwitchProfile;
    const selectedModel = multiSpeakerProfile
      ? "nova-3"
      : codeSwitchProfile
        ? (env.DEEPGRAM_CODE_SWITCH_MODEL ?? "nova-3")
        : useMultilingualConfig
          ? (env.DEEPGRAM_FLUX_MODEL ?? "flux")
          : model;
    const isFlux = isFluxModel(selectedModel);
    const codeSwitchLanguage = resolveDeepgramCodeSwitchLanguage(env, profile);
    const report = await runSTTAdapterBenchmark({
      adapter: deepgram({
        apiKey: env.DEEPGRAM_API_KEY,
        ...(isFlux
          ? {
              connectTimeoutMs: 12_000,
              eagerEotThreshold: 0.8,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: ["help", "support", "issue", "problem"],
              model: selectedModel,
            }
          : {
              connectTimeoutMs: 12_000,
              diarize: multiSpeakerProfile ? true : undefined,
              endpointing: false,
              interimResults: true,
              keyterms: ["help", "support", "issue", "problem"],
              language: codeSwitchProfile
                ? codeSwitchLanguage
                : env.DEEPGRAM_LANGUAGE,
              model: selectedModel,
              punctuate: true,
              smartFormat: true,
              utteranceEndMs: 1_500,
              vadEvents: true,
            }),
      }),
      adapterId: multiSpeakerProfile
        ? "deepgram-diarized"
        : profile === "multilingual" || codeSwitchProfile
          ? "deepgram-multilingual"
          : isFlux
            ? "deepgram-flux"
            : "deepgram",
      fixtures,
      options: {
        fixtureOptions: {
          "rainstorms-noisy": {
            transcriptThreshold: 0.4,
          },
        },
        idleTimeoutMs: 10_000,
        openOptions: (fixture) => ({
          ...(buildBenchmarkOpenOptions(profile)(fixture) ?? {}),
          lexicon: buildBenchmarkLexicon(profile)(fixture),
          phraseHints: buildBenchmarkPhraseHints(profile)(fixture),
        }),
        settleMs: 1_000,
        tailPaddingMs: 1_500,
        transcriptThreshold: isFlux ? 0.18 : 0.2,
        waitForRealtimeMs: 100,
      },
    });

    if (target === "deepgram-corrected") {
      return applyTargetCorrections(target, profile, report, fixtures);
    }

    if (target === "deepgram-corrected-audit") {
      return buildCorrectionBenchmarkAudit(report, fixtures) as never;
    }

    return report;
  }

  if (target === "openai" || target === "openai-corrected") {
    if (!env.OPENAI_API_KEY) {
      return null;
    }

    const report = await runSTTAdapterBenchmark({
      adapter: asRealtimeSTTAdapter(
        openai(buildOpenAIBenchmarkConfig(env, profile)),
      ),
      adapterId: "openai",
      fixtures,
      options: {
        fixtureOptions: {
          "rainstorms-noisy": {
            transcriptThreshold: 0.4,
          },
        },
        idleTimeoutMs: 12_000,
        openOptions: (fixture) => ({
          ...(buildBenchmarkOpenOptions(profile)(fixture) ?? {}),
          lexicon: buildBenchmarkLexicon(profile)(fixture),
          phraseHints: buildBenchmarkPhraseHints(profile)(fixture),
        }),
        settleMs: 2_500,
        tailPaddingMs: 1_500,
        transcriptThreshold: 0.2,
        waitForRealtimeMs: 120,
      },
    });

    return target === "openai-corrected"
      ? applyTargetCorrections(target, profile, report, fixtures)
      : report;
  }

  if (!env.ASSEMBLYAI_API_KEY) {
    return null;
  }

  return await runSTTAdapterBenchmark({
    adapter: assemblyai({
      apiKey: env.ASSEMBLYAI_API_KEY,
      endOfTurnConfidenceThreshold: 0.55,
      formatTurns: true,
      maxTurnSilence: 4_000,
      minEndOfTurnSilenceWhenConfident: 1_200,
      speechModel: "u3-rt-pro",
    }),
    adapterId: "assemblyai",
    fixtures,
    options: {
      fixtureOptions: {
        "rainstorms-noisy": {
          transcriptThreshold: 0.5,
        },
      },
      idleTimeoutMs: 10_000,
      openOptions: (fixture) => ({
        ...(buildBenchmarkOpenOptions(profile)(fixture) ?? {}),
        lexicon: buildBenchmarkLexicon(profile)(fixture),
        phraseHints: buildBenchmarkPhraseHints(profile)(fixture),
      }),
      settleMs: 1_000,
      tailPaddingMs: 1_500,
      transcriptThreshold: 0.3,
      waitForRealtimeMs: 100,
    },
  });
};

const loadSeriesReport = async (
  target:
    | "deepgram"
    | "deepgram-corrected"
    | "assemblyai"
    | "openai"
    | "openai-corrected",
  profile: VoiceBenchmarkProfile,
  env: VoiceBenchEnv,
  runs: number,
) => {
  const fixtures = await filterFixturesForProfile(profile);

  if (fixtures.length === 0) {
    throw new Error(buildMissingProfileError(profile));
  }

  if (target === "deepgram" || target === "deepgram-corrected") {
    if (!env.DEEPGRAM_API_KEY) {
      return null;
    }

    if (target === "deepgram-corrected") {
      const correctedReports: VoiceSTTBenchmarkReport[] = [];
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const report = await loadReport("deepgram-corrected", profile, env);
        if (!report) {
          return null;
        }
        correctedReports.push(report);
      }

      return summarizeSTTBenchmarkSeries({
        adapterId: target,
        reports: correctedReports,
      });
    }

    const model = resolveDeepgramModel(env);
    const codeSwitchProfile = isCodeSwitchProfile(profile);
    const multiSpeakerProfile = isMultiSpeakerProfile(profile);
    const useMultilingualConfig =
      profile === "multilingual" || codeSwitchProfile;
    const selectedModel = multiSpeakerProfile
      ? "nova-3"
      : codeSwitchProfile
        ? (env.DEEPGRAM_CODE_SWITCH_MODEL ?? "nova-3")
        : useMultilingualConfig
          ? (env.DEEPGRAM_FLUX_MODEL ?? "flux")
          : model;
    const isFlux = isFluxModel(selectedModel);
    const codeSwitchLanguage = resolveDeepgramCodeSwitchLanguage(env, profile);

    return await runSTTAdapterBenchmarkSeries({
      adapter: deepgram({
        apiKey: env.DEEPGRAM_API_KEY,
        ...(isFlux
          ? {
              connectTimeoutMs: 12_000,
              eagerEotThreshold: 0.8,
              eotThreshold: 0.82,
              eotTimeoutMs: 1_200,
              keyterms: ["help", "support", "issue", "problem"],
              model: selectedModel,
            }
          : {
              connectTimeoutMs: 12_000,
              diarize: multiSpeakerProfile ? true : undefined,
              endpointing: false,
              interimResults: true,
              keyterms: ["help", "support", "issue", "problem"],
              language: codeSwitchProfile
                ? codeSwitchLanguage
                : env.DEEPGRAM_LANGUAGE,
              model: selectedModel,
              punctuate: true,
              smartFormat: true,
              utteranceEndMs: 1_500,
              vadEvents: true,
            }),
      }),
      adapterId: multiSpeakerProfile
        ? "deepgram-diarized"
        : profile === "multilingual" || codeSwitchProfile
          ? "deepgram-multilingual"
          : isFlux
            ? "deepgram-flux"
            : "deepgram",
      fixtures,
      options: {
        fixtureOptions: {
          "rainstorms-noisy": {
            transcriptThreshold: 0.4,
          },
        },
        idleTimeoutMs: 10_000,
        openOptions: (fixture) => ({
          ...(buildBenchmarkOpenOptions(profile)(fixture) ?? {}),
          lexicon: buildBenchmarkLexicon(profile)(fixture),
          phraseHints: buildBenchmarkPhraseHints(profile)(fixture),
        }),
        settleMs: 1_000,
        tailPaddingMs: 1_500,
        transcriptThreshold: isFlux ? 0.18 : 0.2,
        waitForRealtimeMs: 100,
      },
      runs,
    });
  }

  if (target === "openai" || target === "openai-corrected") {
    if (!env.OPENAI_API_KEY) {
      return null;
    }

    if (target === "openai-corrected") {
      const correctedReports: VoiceSTTBenchmarkReport[] = [];
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const report = await loadReport("openai-corrected", profile, env);
        if (!report) {
          return null;
        }
        correctedReports.push(report);
      }

      return summarizeSTTBenchmarkSeries({
        adapterId: target,
        reports: correctedReports,
      });
    }

    return await runSTTAdapterBenchmarkSeries({
      adapter: asRealtimeSTTAdapter(
        openai(buildOpenAIBenchmarkConfig(env, profile)),
      ),
      adapterId: "openai",
      fixtures,
      options: {
        fixtureOptions: {
          "rainstorms-noisy": {
            transcriptThreshold: 0.4,
          },
        },
        idleTimeoutMs: 12_000,
        openOptions: (fixture) => ({
          ...(buildBenchmarkOpenOptions(profile)(fixture) ?? {}),
          lexicon: buildBenchmarkLexicon(profile)(fixture),
          phraseHints: buildBenchmarkPhraseHints(profile)(fixture),
        }),
        settleMs: 2_500,
        tailPaddingMs: 1_500,
        transcriptThreshold: 0.2,
        waitForRealtimeMs: 120,
      },
      runs,
    });
  }

  if (!env.ASSEMBLYAI_API_KEY) {
    return null;
  }

  return await runSTTAdapterBenchmarkSeries({
    adapter: assemblyai({
      apiKey: env.ASSEMBLYAI_API_KEY,
      endOfTurnConfidenceThreshold: 0.55,
      formatTurns: true,
      maxTurnSilence: 4_000,
      minEndOfTurnSilenceWhenConfident: 1_200,
      speechModel: "u3-rt-pro",
    }),
    adapterId: "assemblyai",
    fixtures,
    options: {
      fixtureOptions: {
        "rainstorms-noisy": {
          transcriptThreshold: 0.5,
        },
      },
      idleTimeoutMs: 10_000,
      openOptions: (fixture) => ({
        ...(buildBenchmarkOpenOptions(profile)(fixture) ?? {}),
        lexicon: buildBenchmarkLexicon(profile)(fixture),
        phraseHints: buildBenchmarkPhraseHints(profile)(fixture),
      }),
      settleMs: 1_000,
      tailPaddingMs: 1_500,
      transcriptThreshold: 0.3,
      waitForRealtimeMs: 100,
    },
    runs,
  });
};

const runOpenAIDiagnosticProbe = async (env: VoiceBenchEnv) => {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in voice/.env");
  }

  const fixtures = await loadVoiceTestFixtures();
  const fixture = fixtures.find((entry) => entry.id === "quietly-alone-clean");

  if (!fixture) {
    throw new Error("No fixture found for OpenAI diagnostic probe.");
  }

  const responseMode =
    (process.env.OPENAI_RESPONSE_MODE as "text" | "audio" | undefined) ??
    env.OPENAI_RESPONSE_MODE ??
    "text";

  const targetModels = [
    undefined,
    "gpt-4o-mini-realtime-preview",
    "gpt-realtime",
    "gpt-realtime-1.5",
  ] as const;
  const configuredModels = (env.OPENAI_TEST_MODELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is string => value.length > 0);
  const modelsToTry =
    configuredModels.length > 0 ? configuredModels : targetModels;

  const baseFormat: AudioFormat = {
    channels: 1,
    container: "raw",
    encoding: "pcm_s16le",
    sampleRateHz: 24_000,
  };

  const attempts = [];
  const bytesPerMillisecond =
    (baseFormat.sampleRateHz * baseFormat.channels * 2) / 1_000;
  const chunkDurationMs = 100;
  const bytesPerChunk = Math.max(
    2,
    Math.floor(bytesPerMillisecond * chunkDurationMs),
  );
  const resampledAudio = resamplePcm16Mono(
    fixture.audio,
    fixture.format.sampleRateHz,
    baseFormat.sampleRateHz,
  );
  const chunks: Uint8Array[] = [];

  for (
    let offset = 0;
    offset < resampledAudio.byteLength;
    offset += bytesPerChunk
  ) {
    chunks.push(
      resampledAudio.slice(
        offset,
        Math.min(offset + bytesPerChunk, resampledAudio.byteLength),
      ),
    );
  }

  for (let index = 0; index < modelsToTry.length; index += 1) {
    const model = modelsToTry[index];
    const attemptStartedAt = Date.now();
    const adapter = openai({
      apiKey: env.OPENAI_API_KEY!,
      autoCommitSilenceMs: 600,
      responseMode,
      ...(model ? { model } : {}),
    });
    const logs = {
      close: [] as Array<{
        code?: number;
        reason?: string;
        recoverable?: boolean;
      }>,
      errors: [] as Array<{
        code?: string;
        message: string;
        recoverable: boolean;
      }>,
      finalText: "",
    };
    let connected = false;

    try {
      const session = await adapter.open({
        format: baseFormat,
        sessionId: `openai-diagnostic-${index + 1}`,
      });
      connected = true;

      const unsubscribe = [
        session.on("error", (event) => {
          logs.errors.push({
            code: event.code,
            message: event.error.message,
            recoverable: event.recoverable,
          });
        }),
        session.on("close", (event) => {
          logs.close.push({
            code: event.code,
            reason: event.reason,
            recoverable: event.recoverable,
          });
        }),
        session.on("final", (event) => {
          logs.finalText += event.transcript.text;
        }),
      ];

      for (const chunk of chunks) {
        await session.send(chunk);
        await Bun.sleep(120);
      }

      await Bun.sleep(12_000);
      await session.close("openai-benchmark-probe");

      for (const unsubscribeFromEvent of unsubscribe) {
        unsubscribeFromEvent();
      }

      const hasFinalText = logs.finalText.trim().length > 0;
      const hasTransportClose = logs.close.some(
        (entry) => entry.code !== undefined && entry.code !== 1000,
      );
      const hasError = logs.errors.length > 0;
      const ok = hasFinalText && !hasTransportClose && !hasError;

      attempts.push({
        attempt: index + 1,
        model,
        ok,
        attemptLatencyMs: Date.now() - attemptStartedAt,
        connected,
        logs,
      });

      if (ok) {
        break;
      }
    } catch (error) {
      attempts.push({
        attempt: index + 1,
        model,
        ok: false,
        attemptLatencyMs: Date.now() - attemptStartedAt,
        connected,
        error: serializeDiagnosticError(error),
      });
    }
  }

  const success = attempts.find((attempt) => attempt.ok);
  const retryNotice =
    success && success.attempt > 1
      ? {
          retriedWithAlternativeModel: true,
          attemptThatSucceeded: success.attempt,
        }
      : { retriedWithAlternativeModel: false };

  console.log(
    JSON.stringify(
      {
        mode: "openai-diagnostic",
        modelsTried: attempts.map((attempt) => attempt.model ?? "default"),
        success,
        retryNotice,
        attempts,
      },
      null,
      2,
    ),
  );
};

const main = async () => {
  const positionalArgs = process.argv
    .slice(2)
    .filter((entry) => !entry.startsWith("--"));
  const target = (positionalArgs[0] ?? "all") as VoiceBenchmarkTarget;
  const profile = (positionalArgs[1] ?? "all") as VoiceBenchmarkProfile;
  const mode = process.argv.some((entry) =>
    ["--diagnostic", "--diag"].includes(entry),
  )
    ? "diagnostic"
    : "normal";
  const runs = parseRuns();
  const variant = parseVariant();
  const env = await parseEnv();

  if (mode === "diagnostic" && target === "openai") {
    const outputPath = resolveOutputPath(target, profile, mode, runs, variant);
    await clearBenchmarkResultStem(
      buildResultStem(target, profile, mode, runs, variant),
    );
    const originalConsoleLog = console.log;
    let serialized = "";
    console.log = (...args: unknown[]) => {
      serialized = args.join(" ");
      originalConsoleLog(...args);
    };
    try {
      await runOpenAIDiagnosticProbe(env);
    } finally {
      console.log = originalConsoleLog;
    }
    if (serialized) {
      await Bun.write(outputPath, serialized);
      console.log(`\nSaved benchmark JSON to ${outputPath}`);
    }
    return;
  }

  if (
    target === "deepgram" ||
    target === "deepgram-corrected" ||
    target === "deepgram-corrected-audit" ||
    target === "assemblyai" ||
    target === "openai" ||
    target === "openai-corrected"
  ) {
    if (
      runs > 1 &&
      (target === "deepgram" ||
        target === "deepgram-corrected" ||
        target === "assemblyai" ||
        target === "openai" ||
        target === "openai-corrected")
    ) {
      const report = await loadSeriesReport(target, profile, env, runs);
      if (!report) {
        if (target === "openai" || target === "openai-corrected") {
          throw new Error("Missing OPENAI_API_KEY in voice/.env");
        }

        throw new Error(
          `Missing ${target === "deepgram" ? "DEEPGRAM_API_KEY" : "ASSEMBLYAI_API_KEY"} in voice/.env`,
        );
      }

      const outputPath = resolveOutputPath(
        target,
        profile,
        mode,
        runs,
        variant,
      );
      await clearBenchmarkResultStem(
        buildResultStem(target, profile, mode, runs, variant),
      );
      await Bun.write(outputPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      console.log(`\nSaved benchmark JSON to ${outputPath}`);
      return;
    }

    const report = await loadReport(target, profile, env);
    if (!report) {
      if (target === "openai") {
        throw new Error("Missing OPENAI_API_KEY in voice/.env");
      }

      throw new Error(
        `Missing ${target === "deepgram" ? "DEEPGRAM_API_KEY" : "ASSEMBLYAI_API_KEY"} in voice/.env`,
      );
    }

    const outputPath = resolveOutputPath(target, profile, mode, runs, variant);
    await clearBenchmarkResultStem(
      buildResultStem(target, profile, mode, runs, variant),
    );
    await Bun.write(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nSaved benchmark JSON to ${outputPath}`);
    return;
  }

  if (runs > 1) {
    const reports = (
      await Promise.all([
        loadSeriesReport("deepgram", profile, env, runs),
        loadSeriesReport("assemblyai", profile, env, runs),
        loadSeriesReport("openai", profile, env, runs),
      ])
    ).filter((entry) => entry !== null);

    if (reports.length === 0) {
      throw new Error(
        "No benchmarkable STT adapters are configured. Add DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, or OPENAI_API_KEY to voice/.env.",
      );
    }

    const output = { reports };
    const outputPath = resolveOutputPath(target, profile, mode, runs, variant);
    await clearBenchmarkResultStem(
      buildResultStem(target, profile, mode, runs, variant),
    );
    await Bun.write(outputPath, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
    console.log(`\nSaved benchmark JSON to ${outputPath}`);
    return;
  }

  const reports = (
    await Promise.all([
      loadReport("deepgram", profile, env),
      loadReport("assemblyai", profile, env),
      loadReport("openai", profile, env),
    ])
  ).filter((entry): entry is VoiceSTTBenchmarkReport => entry !== null);

  if (reports.length === 0) {
    throw new Error(
      "No benchmarkable STT adapters are configured. Add DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, or OPENAI_API_KEY to voice/.env.",
    );
  }

  const output = {
    comparison: compareSTTBenchmarks(reports),
    reports,
  };
  const outputPath = resolveOutputPath(target, profile, mode, runs, variant);
  await clearBenchmarkResultStem(
    buildResultStem(target, profile, mode, runs, variant),
  );
  await Bun.write(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  console.log(`\nSaved benchmark JSON to ${outputPath}`);
};

await main();
