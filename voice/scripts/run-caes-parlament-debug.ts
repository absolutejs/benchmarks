import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { deepgram } from "@absolutejs/voice-deepgram";
import {
  buildCodeSwitchBenchmarkLexicon,
  buildCodeSwitchBenchmarkPhraseHints,
  loadVoiceTestFixtures,
  runSTTAdapterFixture,
  scoreTranscriptAccuracy,
} from "@absolutejs/voice/testing";
import { applyLexiconCorrections } from "@absolutejs/voice";
import type { VoiceLanguageStrategy } from "@absolutejs/voice";

const projectRoot = resolve(import.meta.dir, "..");
const benchmarkResultsDir = resolve(projectRoot, "benchmark-results");
const envPath = resolve(projectRoot, ".env");
const defaultFixtureDir = resolve(
  projectRoot,
  "..",
  "..",
  "voice-fixtures-multilingual",
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

const parseEnv = async () => {
  const file = Bun.file(envPath);
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

  const read = (key: string) =>
    normalizeEnvValue(process.env[key]?.trim()) ??
    normalizeEnvValue(values[key]);

  return {
    DEEPGRAM_API_KEY: read("DEEPGRAM_API_KEY"),
    DEEPGRAM_CODE_SWITCH_LANGUAGE:
      read("DEEPGRAM_CODE_SWITCH_LANGUAGE") ?? "ca",
    DEEPGRAM_CODE_SWITCH_MODEL: read("DEEPGRAM_CODE_SWITCH_MODEL") ?? "nova-3",
    VOICE_FIXTURE_DIR: read("VOICE_FIXTURE_DIR") ?? defaultFixtureDir,
  };
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

const hasNormalizedTag = (tags: string[] | undefined, target: string) =>
  (tags ?? []).map((tag) => tag.trim().toLowerCase()).includes(target);

const isCaEsFixture = (fixture: { language?: string; tags?: string[] }) =>
  normalizeLanguageCode(fixture.language) === "ca-es" ||
  hasNormalizedTag(fixture.tags, "ca-es");

const env = await parseEnv();

if (!env.DEEPGRAM_API_KEY) {
  throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
}

const fixtures = (
  await loadVoiceTestFixtures({
    directories: env.VOICE_FIXTURE_DIR ? [env.VOICE_FIXTURE_DIR] : undefined,
  })
).filter(
  (fixture) =>
    hasNormalizedTag(fixture.tags, "code-switch") &&
    isCaEsFixture(fixture) &&
    hasNormalizedTag(fixture.tags, "parlament_parla"),
);

if (fixtures.length === 0) {
  throw new Error("No CA-ES parlament_parla fixtures found.");
}

const adapter = deepgram({
  apiKey: env.DEEPGRAM_API_KEY,
  connectTimeoutMs: 12_000,
  endpointing: false,
  interimResults: true,
  keyterms: ["help", "support", "issue", "problem"],
  language: env.DEEPGRAM_CODE_SWITCH_LANGUAGE,
  model: env.DEEPGRAM_CODE_SWITCH_MODEL,
  punctuate: true,
  smartFormat: true,
  utteranceEndMs: 1_500,
  vadEvents: true,
});

const results = [];

for (const fixture of fixtures) {
  const lexicon = buildCodeSwitchBenchmarkLexicon(fixture);
  const phraseHints = buildCodeSwitchBenchmarkPhraseHints(fixture);
  const raw = await runSTTAdapterFixture(adapter, fixture, {
    idleTimeoutMs: 10_000,
    openOptions: {
      languageStrategy: resolveFixtureLanguageStrategy(fixture),
      lexicon,
      phraseHints,
    },
    settleMs: 1_000,
    tailPaddingMs: 1_500,
    transcriptThreshold: 0.2,
    waitForRealtimeMs: 100,
  });

  const corrected = applyLexiconCorrections(raw.finalText, lexicon);
  results.push({
    fixtureId: fixture.id,
    title: fixture.title,
    language: fixture.language,
    tags: fixture.tags ?? [],
    expectedText: fixture.expectedText,
    raw: {
      finalText: raw.finalText,
      accuracy: raw.accuracy,
      errorCount: raw.errorEvents.length,
      endOfTurnCount: raw.endOfTurnEvents.length,
      finals: raw.finalEvents.map((event) => ({
        id: event.transcript.id,
        text: event.transcript.text,
        confidence: event.transcript.confidence,
        language: event.transcript.language,
        receivedAtOffsetMs: event.receivedAt - raw.startedAt,
      })),
      partials: raw.partialEvents.map((event) => ({
        id: event.transcript.id,
        text: event.transcript.text,
        confidence: event.transcript.confidence,
        language: event.transcript.language,
        receivedAtOffsetMs: event.receivedAt - raw.startedAt,
      })),
    },
    corrected: {
      text: corrected.text,
      accuracy: scoreTranscriptAccuracy(
        corrected.text,
        fixture.expectedText,
        0.2,
      ),
      changed: corrected.changed,
      matches: corrected.matches.map((match) => ({
        alias: match.alias,
        text: match.hint.text,
      })),
    },
  });
}

const output = {
  adapter: {
    provider: "deepgram",
    model: env.DEEPGRAM_CODE_SWITCH_MODEL,
    language: env.DEEPGRAM_CODE_SWITCH_LANGUAGE,
  },
  fixtureCount: fixtures.length,
  results,
};

await mkdir(benchmarkResultsDir, { recursive: true });

const outputPath = resolve(benchmarkResultsDir, "caes-parlament-debug.json");
await Bun.write(outputPath, JSON.stringify(output, null, 2));

console.log(JSON.stringify(output, null, 2));
console.log(`\nSaved debug JSON to ${outputPath}`);
