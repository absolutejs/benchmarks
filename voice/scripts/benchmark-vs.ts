import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { deepgram } from "@absolutejs/voice-deepgram";
import { assemblyai } from "@absolutejs/voice-assemblyai";
import { openai } from "@absolutejs/voice-openai";
import {
  compareSTTBenchmarks,
  createJargonVoiceTestFixtures,
  createMultiSpeakerVoiceTestFixtures,
  createTelephonyVoiceTestFixtures,
  evaluateSTTBenchmarkAcceptance,
  loadVoiceTestFixtures,
  runSTTAdapterBenchmark,
  type VoiceSTTBenchmarkComparison,
  type VoiceSTTBenchmarkReport,
} from "@absolutejs/voice/testing";
import type {
  AudioChunk,
  AudioFormat,
  RealtimeAdapter,
  STTAdapter,
  STTAdapterOpenOptions,
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

type VsProfile =
  | "all"
  | "accents"
  | "baseline"
  | "clean"
  | "code-switch"
  | "jargon"
  | "multilingual"
  | "multi-speaker"
  | "noisy"
  | "telephony";
type VsTarget =
  | "all"
  | "deepgram"
  | "deepgram-nova"
  | "deepgram-flux"
  | "assemblyai"
  | "openai";

type VsEnv = {
  ASSEMBLYAI_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_FLUX_MODEL?: string;
  DEEPGRAM_LANGUAGE?: string;
  DEEPGRAM_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_RESPONSE_MODE?: "text" | "audio";
  OPENAI_TEST_MODELS?: string;
  VOICE_COMPETITOR_RESULTS?: string;
};

type VsAcceptanceSummary = {
  passRate: number;
  wordAccuracyRate: number;
  averageTermRecall: number;
};

type VsTargetSummaryFailure = {
  adapter: VsTarget;
  error: string;
};

type VsComparativeEntry = {
  adapterId: string;
  source: string;
  summary: {
    passRate: number;
    averageWordErrorRate: number;
    averageTermRecall: number;
    averageElapsedMs: number;
    averageTimeToEndOfTurnMs?: number;
    averageTimeToFirstFinalMs?: number;
    averageTimeToFirstPartialMs?: number;
    wordAccuracyRate: number;
  };
};

type VsComparisonRecord = {
  adapterId: string;
  passRateDeltaVsVapi?: number;
  summary: VsComparativeEntry["summary"];
  source: string;
};

type VsBenchmarkOutput = {
  comparison: VoiceSTTBenchmarkComparison;
  acceptance: Record<string, { passed: boolean; score: number }>;
  entries: VsComparativeEntry[];
  profile: VsProfile;
  targets: VsTarget[];
  competitors: VsComparisonRecord[];
  generatedAt: number;
  scorecard: Array<{
    adapterId: string;
    score: number;
    passRate: number;
    wordAccuracyRate: number;
    termRecall: number;
  }>;
};

type CompetitorPayload = {
  source: string;
  generatedAt?: number;
  results: Array<{
    adapterId: string;
    summary: Partial<VsComparativeEntry["summary"]>;
  }>;
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

const parseEnv = async (): Promise<VsEnv> => {
  const file = Bun.file(ENV_PATH);
  const keys = Object.keys({
    ASSEMBLYAI_API_KEY: undefined,
    DEEPGRAM_API_KEY: undefined,
    DEEPGRAM_FLUX_MODEL: undefined,
    DEEPGRAM_LANGUAGE: undefined,
    DEEPGRAM_MODEL: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_RESPONSE_MODE: undefined,
    OPENAI_TEST_MODELS: undefined,
    VOICE_COMPETITOR_RESULTS: undefined,
  }) as Array<keyof VsEnv>;
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

      values[trimmed.slice(0, separatorIndex).trim()] = trimmed
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }
  }

  const read = (key: keyof VsEnv): string | undefined => {
    const processValue = process.env[key]?.trim();
    if (processValue && processValue.length > 0) {
      return normalizeEnvValue(processValue);
    }

    return normalizeEnvValue(values[key]);
  };

  return keys.reduce((acc, key) => {
    acc[key] = read(key);
    return acc;
  }, {} as VsEnv);
};

const findArg = (key: string) => {
  const index = process.argv.indexOf(key);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const clearBenchmarkResultFamily = async (prefix: string) => {
  await mkdir(BENCHMARK_RESULTS_DIR, { recursive: true });

  for (const entry of await readdir(BENCHMARK_RESULTS_DIR)) {
    if (
      !entry.startsWith(`${prefix}-`) ||
      (!entry.endsWith(".json") && !entry.endsWith(".md"))
    ) {
      continue;
    }

    await rm(resolve(BENCHMARK_RESULTS_DIR, entry), { force: true });
  }
};

const resolveDefaultOutputPath = (target: VsTarget, profile: VsProfile) =>
  resolve(BENCHMARK_RESULTS_DIR, `vs-${target}-${profile}.json`);

const resolveMarkdownOutputPath = (jsonOutputPath: string) =>
  jsonOutputPath.replace(/\.json$/u, ".md");

const printUsage = () => {
  console.log(`Usage:
  bun run bench:vs [target] [profile]

Targets:
  all          run Deepgram Flux, AssemblyAI, OpenAI (default)
  deepgram     run Deepgram Flux only (default for deepgram)
  deepgram-nova  run Deepgram Nova only
  deepgram-flux  run Deepgram Flux only
  assemblyai   run AssemblyAI only
  openai       run OpenAI only

Profiles:
  all          all fixtures
  accents      accent-heavy fixtures only
  clean        clean (noisy-free) fixtures
  code-switch  code-switch fixtures only
  jargon       jargon/domain-heavy fixtures
  multilingual multilingual fixtures only
  multi-speaker multi-speaker diarization fixtures only
  noisy        noisy fixtures
  telephony    telephony/narrowband fixtures only
  baseline     non-accent fixtures

Options:
  --compare <path>   include external competitor metrics JSON
  --out <path>       write JSON summary to file
  --dry-run          print plan only (no live calls)
`);
};

const toNumber = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeRange = (value: number | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(1, Math.max(0, value));
};

const percent = (value: number | undefined) =>
  typeof value !== "number" || Number.isNaN(value)
    ? "0.0%"
    : `${(value * 100).toFixed(2)}%`;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const compareScore = (summary: {
  passRate: number;
  averageTermRecall: number;
  wordAccuracyRate: number;
}) =>
  clamp(summary.passRate) * 0.45 +
  clamp(summary.wordAccuracyRate) * 0.35 +
  clamp(summary.averageTermRecall) * 0.2;

const resolveProfile = (value: string | undefined): VsProfile => {
  if (
    value === "accents" ||
    value === "baseline" ||
    value === "clean" ||
    value === "code-switch" ||
    value === "jargon" ||
    value === "multilingual" ||
    value === "multi-speaker" ||
    value === "noisy" ||
    value === "telephony"
  ) {
    return value;
  }

  return "all";
};

const resolveTarget = (value: string | undefined): VsTarget => {
  if (
    value === "deepgram" ||
    value === "deepgram-nova" ||
    value === "deepgram-flux" ||
    value === "assemblyai" ||
    value === "openai"
  ) {
    return value;
  }

  return "all";
};

const PROFILE_FILTERS: Record<
  Exclude<VsProfile, "all">,
  (tags: string[]) => boolean
> = {
  accents: (tags) => tags.some((tag) => tag.includes("accent")),
  baseline: (tags) => !tags.some((tag) => tag.includes("accent")),
  clean: (tags) =>
    tags.some((tag) => tag === "clean") ||
    !tags.some((tag) =>
      ["accent", "accent-noisy", "noisy", "synthetic-noise", "stress"].includes(
        tag,
      ),
    ),
  "code-switch": (tags) =>
    tags.some((tag) => tag === "code-switch" || tag === "code_switch"),
  jargon: (tags) =>
    tags.some((tag) => tag === "jargon" || tag === "domain-heavy"),
  multilingual: (tags) =>
    tags.some(
      (tag) =>
        tag === "multilingual" ||
        tag === "international" ||
        tag === "code-switch" ||
        tag === "code_switch",
    ),
  "multi-speaker": (tags) => tags.some((tag) => tag === "multi-speaker"),
  noisy: (tags) =>
    tags.some((tag) => ["noisy", "synthetic-noise", "stress"].includes(tag)),
  telephony: (tags) => tags.some((tag) => tag === "telephony"),
};

const resolveOpenAIModel = (env: VsEnv): string | undefined => {
  const configured = (env.OPENAI_TEST_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is string => entry.length > 0);

  return configured[0];
};

const resolveDeepgramConfig = (
  target: Exclude<VsTarget, "all">,
  profile: VsProfile,
  env: VsEnv,
) => {
  if (target === "deepgram" || target === "deepgram-flux") {
    return {
      connectTimeoutMs: 12_000,
      eagerEotThreshold: 0.8,
      keyterms: ["help", "support", "issue", "problem"],
      model: env.DEEPGRAM_FLUX_MODEL ?? "flux-general-en",
      eotThreshold: 0.82,
      eotTimeoutMs: profile === "accents" ? 1_500 : 1_200,
    };
  }

  return {
    connectTimeoutMs: 12_000,
    endpointing: false,
    interimResults: true,
    keyterms: ["help", "support", "issue", "problem"],
    language: env.DEEPGRAM_LANGUAGE ?? "en",
    model: env.DEEPGRAM_MODEL ?? "nova-3",
    punctuate: true,
    smartFormat: true,
    utteranceEndMs: 1_500,
    vadEvents: true,
  };
};

const resolveDeepgramAdapterId = (target: Exclude<VsTarget, "all">) => {
  if (target === "deepgram" || target === "deepgram-flux") {
    return "deepgram-flux";
  }

  if (target === "deepgram-nova") {
    return "deepgram-nova";
  }

  return "deepgram";
};

const resolveAcceptanceThreshold = (
  profile: VsProfile,
): VsAcceptanceSummary => {
  if (profile === "accents") {
    return { averageTermRecall: 0.55, passRate: 0.75, wordAccuracyRate: 0.65 };
  }

  if (profile === "noisy") {
    return { averageTermRecall: 0.5, passRate: 0.74, wordAccuracyRate: 0.62 };
  }

  if (profile === "jargon") {
    return { averageTermRecall: 0.8, passRate: 0.75, wordAccuracyRate: 0.85 };
  }

  if (profile === "telephony") {
    return { averageTermRecall: 0.75, passRate: 0.75, wordAccuracyRate: 0.82 };
  }

  if (profile === "multilingual") {
    return { averageTermRecall: 0.7, passRate: 0.8, wordAccuracyRate: 0.82 };
  }

  if (profile === "code-switch") {
    return { averageTermRecall: 0.55, passRate: 0.7, wordAccuracyRate: 0.72 };
  }

  if (profile === "multi-speaker") {
    return { averageTermRecall: 0.72, passRate: 0.75, wordAccuracyRate: 0.85 };
  }

  return { averageTermRecall: 0.72, passRate: 0.86, wordAccuracyRate: 0.8 };
};

const loadFixturesForProfile = async (profile: VsProfile) => {
  const fixtures = await loadVoiceTestFixtures();
  if (profile === "telephony") {
    return createTelephonyVoiceTestFixtures(fixtures);
  }

  if (profile === "multi-speaker") {
    return createMultiSpeakerVoiceTestFixtures(fixtures);
  }

  if (profile === "jargon") {
    return createJargonVoiceTestFixtures(fixtures);
  }

  return fixtures.filter((fixture) => {
    const tags = fixture.tags ?? [];
    if (profile === "all") {
      return true;
    }

    return PROFILE_FILTERS[profile](tags);
  });
};

const loadReport = async (
  target: Exclude<VsTarget, "all">,
  profile: VsProfile,
  env: VsEnv,
): Promise<VoiceSTTBenchmarkReport | null> => {
  const fixtures = await loadFixturesForProfile(profile);

  if (fixtures.length === 0) {
    throw new Error(`No fixtures matched benchmark profile "${profile}".`);
  }

  if (
    target === "deepgram" ||
    target === "deepgram-nova" ||
    target === "deepgram-flux"
  ) {
    if (!env.DEEPGRAM_API_KEY) {
      return null;
    }

    return await runSTTAdapterBenchmark({
      adapter: deepgram({
        ...resolveDeepgramConfig(target, profile, env),
        apiKey: env.DEEPGRAM_API_KEY,
      }),
      adapterId: resolveDeepgramAdapterId(target),
      fixtures,
      options: {
        fixtureOptions: {
          "rainstorms-noisy": {
            transcriptThreshold: 0.4,
          },
        },
        idleTimeoutMs: 12_000,
        settleMs: 2_500,
        tailPaddingMs: 1_500,
        transcriptThreshold:
          target === "deepgram-flux" ? 0.18 : profile === "clean" ? 0.2 : 0.28,
        waitForRealtimeMs: profile === "accents" ? 120 : 100,
      },
    });
  }

  if (target === "assemblyai") {
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
        idleTimeoutMs: 11_000,
        settleMs: 1_000,
        tailPaddingMs: 1_500,
        transcriptThreshold: profile === "noisy" ? 0.35 : 0.3,
        waitForRealtimeMs: 100,
      },
    });
  }

  if (!env.OPENAI_API_KEY) {
    return null;
  }

  const responseMode =
    (process.env.OPENAI_RESPONSE_MODE as "text" | "audio" | undefined) ??
    env.OPENAI_RESPONSE_MODE ??
    "text";

  return await runSTTAdapterBenchmark({
    adapter: asRealtimeSTTAdapter(
      openai({
        apiKey: env.OPENAI_API_KEY,
        autoCommitSilenceMs: 600,
        model: resolveOpenAIModel(env),
        responseMode,
      }),
    ),
    adapterId: "openai",
    fixtures,
    options: {
      idleTimeoutMs: 12_000,
      settleMs: 1_500,
      tailPaddingMs: 1_500,
      transcriptThreshold: 0.28,
      waitForRealtimeMs: 120,
    },
  });
};

const compareWithCompetitors = (entries: VsComparativeEntry[]) => {
  const competitorEntries = entries.filter((entry) => entry.source !== "voice");
  const voiceEntries = entries.filter((entry) => entry.source === "voice");

  const best = voiceEntries.reduce<VsComparativeEntry | null>(
    (winning, current) => {
      if (!winning) {
        return current;
      }
      return compareScore(current.summary) > compareScore(winning.summary)
        ? current
        : winning;
    },
    null,
  );

  if (!best) {
    return {
      best,
      vapiDelta: undefined,
    };
  }

  const vapiEntries = competitorEntries.filter(
    (entry) => entry.source === "vapi",
  );
  const bestVapi = vapiEntries.reduce<VsComparativeEntry | null>(
    (winner, current) => {
      if (!winner) {
        return current;
      }

      return compareScore(current.summary) > compareScore(winner.summary)
        ? current
        : winner;
    },
    null,
  );

  if (!bestVapi) {
    return {
      best,
      vapiDelta: undefined,
    };
  }

  return {
    best,
    vapiDelta: {
      passRateDeltaVsVapi: best.summary.passRate - bestVapi.summary.passRate,
      wordAccuracyRate:
        best.summary.wordAccuracyRate - bestVapi.summary.wordAccuracyRate,
      termRecall:
        best.summary.averageTermRecall - bestVapi.summary.averageTermRecall,
      adapterId: `${best.adapterId} vs ${bestVapi.adapterId}`,
      source: best.source,
    },
  };
};

const renderMarkdownSummary = (input: {
  acceptance: VsBenchmarkOutput["acceptance"];
  comparePath?: string;
  competitors: VsComparisonRecord[];
  output: VsBenchmarkOutput;
}) => {
  const lines: string[] = [];
  lines.push("# STT Competitor Comparison");
  lines.push("");
  lines.push(
    `- Generated: ${new Date(input.output.generatedAt).toISOString()}`,
  );
  lines.push(`- Profile: \`${input.output.profile}\``);
  lines.push(
    `- Targets: ${input.output.targets.map((target) => `\`${target}\``).join(", ")}`,
  );
  if (input.comparePath) {
    lines.push(`- Competitor baseline: \`${input.comparePath}\``);
  }
  lines.push("");
  lines.push("## Voice Scorecard");
  lines.push("");
  lines.push(
    "| Adapter | Score | Pass Rate | Accuracy | Term Recall | Acceptance |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");

  for (const item of input.output.scorecard) {
    const adapterId = item.adapterId.replace(/^voice:/u, "");
    const status = input.acceptance[adapterId]?.passed ? "PASS" : "FAIL";
    lines.push(
      `| ${adapterId} | ${(item.score * 100).toFixed(1)} | ${percent(item.passRate)} | ${percent(item.wordAccuracyRate)} | ${percent(item.termRecall)} | ${status} |`,
    );
  }

  lines.push("");
  lines.push("## Competitor Deltas");
  lines.push("");

  if (input.competitors.length === 0) {
    lines.push("No competitor baseline entries were provided.");
  } else {
    lines.push(
      "| Competitor | Pass Delta Vs Voice | Accuracy | Term Recall | Latency |",
    );
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    for (const competitor of input.competitors) {
      lines.push(
        `| ${competitor.source}:${competitor.adapterId} | ${
          competitor.passRateDeltaVsVapi !== undefined
            ? `${(competitor.passRateDeltaVsVapi * 100).toFixed(2)}%`
            : "n/a"
        } | ${percent(competitor.summary.wordAccuracyRate)} | ${percent(
          competitor.summary.averageTermRecall,
        )} | ${competitor.summary.averageElapsedMs.toFixed(0)}ms |`,
      );
    }
  }

  lines.push("");
  lines.push("## Comparison Summary");
  lines.push("");
  lines.push(
    `- Best voice adapter: \`${input.output.scorecard[0]?.adapterId.replace(/^voice:/u, "") ?? "n/a"}\``,
  );
  lines.push(
    `- Compared voice adapters: ${input.output.entries
      .filter((entry) => entry.source === "voice")
      .map((entry) => `\`${entry.adapterId}\``)
      .join(", ")}`,
  );

  return `${lines.join("\n")}\n`;
};

const normalizeCompetitorSummary = (
  entry: CompetitorPayload["results"][number],
): VsComparativeEntry["summary"] => {
  const passRate = normalizeRange(entry.summary.passRate);
  const averageTermRecall =
    normalizeRange(entry.summary.averageTermRecall) ?? passRate;
  const averageElapsedMs = toNumber(`${entry.summary.averageElapsedMs}`) ?? 0;
  const rawWordAccuracyRate = toNumber(`${entry.summary.wordAccuracyRate}`);
  let averageWordErrorRate = toNumber(`${entry.summary.averageWordErrorRate}`);
  const averageTimeToEndOfTurnMs = toNumber(
    `${entry.summary.averageTimeToEndOfTurnMs}`,
  );
  const averageTimeToFirstFinalMs = toNumber(
    `${entry.summary.averageTimeToFirstFinalMs}`,
  );
  const averageTimeToFirstPartialMs = toNumber(
    `${entry.summary.averageTimeToFirstPartialMs}`,
  );
  const wordAccuracyRate = normalizeRange(entry.summary.wordAccuracyRate);

  if (averageWordErrorRate === undefined && wordAccuracyRate !== undefined) {
    averageWordErrorRate = clamp(1 - wordAccuracyRate);
  }

  if (averageWordErrorRate === undefined && passRate !== undefined) {
    averageWordErrorRate = clamp(1 - passRate);
  }

  const normalizedWordAccuracyRate =
    wordAccuracyRate ??
    (averageWordErrorRate !== undefined
      ? clamp(1 - averageWordErrorRate)
      : undefined);

  if (
    passRate === undefined ||
    averageTermRecall === undefined ||
    normalizedWordAccuracyRate === undefined ||
    typeof averageElapsedMs !== "number" ||
    typeof averageWordErrorRate !== "number"
  ) {
    throw new Error(
      `Competitor fixture summary invalid for "${entry.adapterId}".`,
    );
  }

  return {
    averageElapsedMs,
    averageTermRecall,
    averageTimeToEndOfTurnMs,
    averageTimeToFirstFinalMs,
    averageTimeToFirstPartialMs,
    averageWordErrorRate,
    passRate,
    wordAccuracyRate: normalizedWordAccuracyRate,
  };
};

const loadCompetitorResults = async (
  path: string | undefined,
): Promise<VsComparativeEntry[]> => {
  if (!path) {
    return [];
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Competitor file not found: ${path}`);
  }

  const payload = (await file.json()) as CompetitorPayload;
  if (!payload?.source || !Array.isArray(payload.results)) {
    throw new Error(`Invalid competitor payload at ${path}`);
  }

  return payload.results.map((entry) => ({
    adapterId: entry.adapterId,
    source: payload.source,
    summary: normalizeCompetitorSummary(entry),
  }));
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  const positional = args.filter((entry) => !entry.startsWith("--"));
  const rawTarget = positional[0];
  const parsedTarget = resolveTarget(rawTarget);
  const target = parsedTarget;
  const profile = resolveProfile(
    parsedTarget === "all" ? (positional[1] ?? rawTarget) : positional[1],
  );
  const targets =
    target === "all"
      ? (["deepgram", "assemblyai", "openai"] as const)
      : ([target] as const);
  const dryRun = args.includes("--dry-run");
  const requestedProfile = profile;
  const env = await parseEnv();
  const comparePath =
    findArg("--compare") ??
    findArg("--competitor") ??
    findArg("--benchmark") ??
    env.VOICE_COMPETITOR_RESULTS;
  const requestedOutputPath = findArg("--out");
  const outputPath = requestedOutputPath
    ? resolve(process.cwd(), requestedOutputPath)
    : resolveDefaultOutputPath(target, requestedProfile);
  const competitorEntries = await loadCompetitorResults(comparePath);

  if (dryRun) {
    const fixtures = await loadFixturesForProfile(requestedProfile);

    const plan = {
      dryRun,
      fixtureCount: fixtures.length,
      profile: requestedProfile,
      targets,
      keysAvailable: {
        assemblyai: Boolean(env.ASSEMBLYAI_API_KEY),
        deepgram: Boolean(env.DEEPGRAM_API_KEY),
        openai: Boolean(env.OPENAI_API_KEY),
      },
      compareSource: comparePath ? comparePath : null,
    };
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const reportResults = await Promise.allSettled(
    targets.map(async (entry) => loadReport(entry, requestedProfile, env)),
  );
  const failures: VsTargetSummaryFailure[] = [];

  let reports = reportResults
    .map((result, index) => {
      const adapter = targets[index];
      if (result.status === "fulfilled" && result.value) {
        return result.value;
      }

      if (result.status === "rejected") {
        failures.push({
          adapter,
          error: (result.reason as Error)?.message ?? `${result.reason}`,
        });
      }

      return null;
    })
    .filter((entry): entry is VoiceSTTBenchmarkReport => entry !== null);

  if (failures.length > 0) {
    console.warn("Some adapters could not be benchmarked:");
    for (const failure of failures) {
      console.warn(`- ${failure.adapter}: ${failure.error}`);
    }
  }

  if (reports.length === 0) {
    const needs =
      target === "all"
        ? "DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, or OPENAI_API_KEY"
        : target.startsWith("deepgram")
          ? "DEEPGRAM_API_KEY"
          : `${target.toUpperCase()}_API_KEY`;
    throw new Error(
      `No benchmarkable adapters are configured: missing ${needs}.`,
    );
  }

  const comparison = compareSTTBenchmarks(reports);
  const entries: VsComparativeEntry[] = reports.map((report) => ({
    adapterId: report.adapterId,
    source: "voice",
    summary: {
      averageElapsedMs: report.summary.averageElapsedMs,
      averageTermRecall: report.summary.averageTermRecall,
      averageTimeToEndOfTurnMs: report.summary.averageTimeToEndOfTurnMs,
      averageTimeToFirstFinalMs: report.summary.averageTimeToFirstFinalMs,
      averageTimeToFirstPartialMs: report.summary.averageTimeToFirstPartialMs,
      averageWordErrorRate: report.summary.averageWordErrorRate,
      passRate: report.summary.passRate,
      wordAccuracyRate: report.summary.wordAccuracyRate,
    },
  }));

  const acceptance = Object.fromEntries(
    reports.map((report) => {
      const acceptanceResult = evaluateSTTBenchmarkAcceptance(
        report,
        resolveAcceptanceThreshold(requestedProfile),
      );
      return [
        report.adapterId,
        {
          passed: acceptanceResult.passed,
          score: acceptanceResult.score,
        },
      ];
    }),
  );

  const scorecard = [...entries]
    .map((entry) => ({
      adapterId: `${entry.source}:${entry.adapterId}`,
      passRate: entry.summary.passRate,
      score: compareScore(entry.summary),
      termRecall: entry.summary.averageTermRecall,
      wordAccuracyRate: entry.summary.wordAccuracyRate,
    }))
    .sort((left, right) => right.score - left.score);

  const rankedComparativeEntries = [...entries, ...competitorEntries].map(
    (entry) => ({
      ...entry,
      // include derived ranking score for easy sort in consumers
      rank: compareScore(entry.summary),
    }),
  ) as (VsComparativeEntry & { rank: number })[];

  const ranked = [...rankedComparativeEntries].sort(
    (left, right) => right.rank - left.rank,
  );
  const best = ranked[0];
  const { best: bestVoice, vapiDelta } = compareWithCompetitors(
    rankedComparativeEntries.map((entry) => ({
      adapterId: entry.adapterId,
      source: entry.source,
      summary: entry.summary,
    })),
  );

  const top = ranked.filter((entry) => entry.source === "voice").slice(0, 1);
  const competitors = ranked
    .filter((entry) => entry.source !== "voice")
    .filter((entry) => entry.source === "vapi")
    .map((entry) => {
      const matching = top[0];
      const passRateDelta = matching
        ? matching.summary.passRate - entry.summary.passRate
        : undefined;
      return {
        adapterId: entry.adapterId,
        passRateDeltaVsVapi: passRateDelta,
        summary: entry.summary,
        source: entry.source,
      };
    });

  const output: VsBenchmarkOutput = {
    acceptance,
    competitors,
    comparison,
    entries: [...entries, ...competitorEntries],
    generatedAt: Date.now(),
    profile: requestedProfile,
    scorecard: scorecard.filter((entry) =>
      entry.adapterId.startsWith("voice:"),
    ),
    targets: target === "all" ? ["all"] : [target],
  };

  const persistedOutput = {
    ...output,
    bestVoice,
    vapiDelta,
  };
  const markdownOutputPath = resolveMarkdownOutputPath(outputPath);
  const markdownSummary = renderMarkdownSummary({
    acceptance,
    comparePath,
    competitors,
    output,
  });

  await clearBenchmarkResultFamily("vs");
  await Bun.write(outputPath, JSON.stringify(persistedOutput, null, 2));
  await Bun.write(markdownOutputPath, markdownSummary);

  console.log(JSON.stringify(persistedOutput, null, 2));

  console.log("\nVoice package benchmark scorecard");
  for (const item of scorecard) {
    const status = acceptance[item.adapterId.replace(/^voice:/, "")]?.passed
      ? "PASS"
      : "FAIL";
    console.log(
      `- ${item.adapterId}: score ${(item.score * 100).toFixed(1)} (pass ${percent(item.passRate)} / recall ${percent(item.termRecall)} / accuracy ${percent(item.wordAccuracyRate)}) => ${status}`,
    );
  }

  if (vapiDelta && vapiDelta.passRateDeltaVsVapi !== undefined) {
    console.log(
      `\nVapi comparison: ${vapiDelta.adapterId} => pass ${vapiDelta.passRateDeltaVsVapi >= 0 ? "ahead" : "behind"} by ${(
        vapiDelta.passRateDeltaVsVapi * 100
      ).toFixed(2)}%`,
    );
    console.log(
      `vapi-adjusted recall delta: ${(vapiDelta.termRecall * 100).toFixed(2)}%`,
    );
    console.log(
      `vapi-adjusted accuracy delta: ${(vapiDelta.wordAccuracyRate * 100).toFixed(2)}%`,
    );
  }

  console.log(`\nSaved benchmark JSON to ${outputPath}`);
  console.log(`Saved benchmark Markdown to ${markdownOutputPath}`);

  if (
    requestedProfile === "accents" &&
    best &&
    best.summary.wordAccuracyRate < 0.65
  ) {
    process.exitCode = 1;
  }
};

await main();
