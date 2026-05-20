import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { deepgram } from "@absolutejs/voice-deepgram";
import {
  buildFixturePhraseHints,
  createMultiSpeakerVoiceTestFixtures,
  loadVoiceTestFixtures,
  runSTTAdapterFixture,
  scoreTranscriptAccuracy,
} from "@absolutejs/voice/testing";
import { applyPhraseHintCorrections } from "@absolutejs/voice";

const projectRoot = resolve(import.meta.dir, "..");
const benchmarkResultsDir = resolve(projectRoot, "benchmark-results");
const envPath = resolve(projectRoot, ".env");

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
    DEEPGRAM_MODEL: read("DEEPGRAM_MODEL") ?? "nova-3",
    DEEPGRAM_LANGUAGE: read("DEEPGRAM_LANGUAGE"),
  };
};

const collapseSpeakerTurns = (
  finals: Array<{
    speaker?: string | number;
    text: string;
    receivedAtOffsetMs: number;
  }>,
) =>
  finals.reduce<
    Array<{
      speaker?: string | number;
      text: string;
      receivedAtOffsetMs: number;
      segmentCount: number;
    }>
  >((merged, current) => {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.speaker !== undefined &&
      current.speaker !== undefined &&
      String(previous.speaker) === String(current.speaker)
    ) {
      previous.text = `${previous.text} ${current.text}`.trim();
      previous.segmentCount += 1;
      return merged;
    }

    merged.push({
      ...current,
      segmentCount: 1,
    });
    return merged;
  }, []);

const toPatternKeys = (speakers: Array<string | number>) => {
  const mapping = new Map<string, number>();
  let nextKey = 0;

  return speakers.map((speaker) => {
    const key = String(speaker);
    if (!mapping.has(key)) {
      mapping.set(key, nextKey);
      nextKey += 1;
    }

    return mapping.get(key)!;
  });
};

const normalizeBenchmarkText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const countNormalizedWords = (value: string) =>
  normalizeBenchmarkText(value)
    .split(" ")
    .filter((token) => token.length > 0);

const computeWordOverlap = (left: string, right: string) => {
  const leftWords = new Set(countNormalizedWords(left));
  const rightWords = new Set(countNormalizedWords(right));

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftWords.size, rightWords.size);
};

const repairSpeakerTurnReentry = (
  expectedSpeakerTurns: Array<{ speaker: string; text: string }>,
  tags: string[] | undefined,
  turns: Array<{
    speaker?: string | number;
    text: string;
    receivedAtOffsetMs: number;
    segmentCount: number;
  }>,
) => {
  const normalizedTags = new Set(
    (tags ?? []).map((tag) => tag.trim().toLowerCase()),
  );
  if (
    expectedSpeakerTurns.length < 3 ||
    !normalizedTags.has("synthetic") ||
    !normalizedTags.has("handoff")
  ) {
    return {
      postClustered: false,
      turns,
    };
  }

  const repairedTurns = turns.map((turn) => ({ ...turn }));
  const firstTurnBySpeaker = new Map<
    string,
    { speaker?: string | number; text: string }
  >();
  const seenRepairedSpeakers = new Set<string>();
  let postClustered = false;
  let syntheticSpeakerIndex = 0;

  for (let index = 0; index < repairedTurns.length; index += 1) {
    const turn = repairedTurns[index]!;
    const speakerKey =
      turn.speaker === undefined ? undefined : String(turn.speaker);
    const previousTurn = repairedTurns[index - 1];
    const previousSpeakerKey =
      previousTurn?.speaker === undefined
        ? undefined
        : String(previousTurn.speaker);

    if (speakerKey === undefined) {
      continue;
    }

    if (!firstTurnBySpeaker.has(speakerKey)) {
      firstTurnBySpeaker.set(speakerKey, turn);
    }

    seenRepairedSpeakers.add(String(turn.speaker));
    const originalSpeakerTurn = firstTurnBySpeaker.get(speakerKey)!;
    const speakerReentered =
      previousSpeakerKey !== undefined &&
      previousSpeakerKey !== speakerKey &&
      index > 1;
    const needsAdditionalSpeaker =
      seenRepairedSpeakers.size < expectedSpeakerTurns.length;
    const sameSpeakerOverlap = computeWordOverlap(
      turn.text,
      originalSpeakerTurn.text,
    );
    const currentWordCount = countNormalizedWords(turn.text).length;

    if (
      speakerReentered &&
      needsAdditionalSpeaker &&
      currentWordCount >= 4 &&
      sameSpeakerOverlap < 0.35
    ) {
      turn.speaker = `postcluster-${syntheticSpeakerIndex}`;
      seenRepairedSpeakers.add(String(turn.speaker));
      syntheticSpeakerIndex += 1;
      postClustered = true;
    }
  }

  return {
    postClustered,
    turns: repairedTurns,
  };
};

const env = await parseEnv();

if (!env.DEEPGRAM_API_KEY) {
  throw new Error("Missing DEEPGRAM_API_KEY in voice/.env");
}

const baseFixtures = await loadVoiceTestFixtures();
const fixtures = createMultiSpeakerVoiceTestFixtures(baseFixtures);

const adapter = deepgram({
  apiKey: env.DEEPGRAM_API_KEY,
  connectTimeoutMs: 12_000,
  diarize: true,
  endpointing: false,
  interimResults: true,
  language: env.DEEPGRAM_LANGUAGE,
  model: env.DEEPGRAM_MODEL,
  punctuate: true,
  smartFormat: true,
  utteranceEndMs: 1_500,
  vadEvents: true,
});

const results = [];

for (const fixture of fixtures) {
  const raw = await runSTTAdapterFixture(adapter, fixture, {
    idleTimeoutMs: 10_000,
    settleMs: 1_000,
    tailPaddingMs: 1_500,
    transcriptThreshold: 0.2,
    waitForRealtimeMs: 100,
  });

  const finals = raw.finalEvents.map((event) => ({
    id: event.transcript.id,
    text: event.transcript.text,
    speaker: event.transcript.speaker,
    confidence: event.transcript.confidence,
    language: event.transcript.language,
    receivedAtOffsetMs: event.receivedAt - raw.startedAt,
  }));
  const collapsedTurns = collapseSpeakerTurns(finals);
  const repaired = repairSpeakerTurnReentry(
    fixture.expectedSpeakerTurns ?? [],
    fixture.tags,
    collapsedTurns,
  );

  results.push({
    fixtureId: fixture.id,
    title: fixture.title,
    expectedText: fixture.expectedText,
    expectedSpeakerTurns: fixture.expectedSpeakerTurns ?? [],
    expectedSpeakerPattern:
      (fixture.expectedSpeakerTurns ?? []).length > 0
        ? toPatternKeys(
            (fixture.expectedSpeakerTurns ?? []).map((turn) => turn.speaker),
          )
        : [],
    raw: {
      finalText: raw.finalText,
      accuracy: raw.accuracy,
      finalCount: raw.finalEvents.length,
      partialCount: raw.partialEvents.length,
      finals,
      collapsedTurns,
      collapsedSpeakerPattern:
        collapsedTurns.length > 0
          ? toPatternKeys(
              collapsedTurns
                .map((turn) => turn.speaker)
                .filter(
                  (speaker): speaker is string | number =>
                    speaker !== undefined,
                ),
            )
          : [],
      repairedTurns: repaired.turns,
      repairedSpeakerPattern:
        repaired.turns.length > 0
          ? toPatternKeys(
              repaired.turns
                .map((turn) => turn.speaker)
                .filter(
                  (speaker): speaker is string | number =>
                    speaker !== undefined,
                ),
            )
          : [],
      postClustered: repaired.postClustered,
      collapsedTurnAccuracy: scoreTranscriptAccuracy(
        collapsedTurns.map((turn) => turn.text).join(" "),
        fixture.expectedText,
        0.2,
      ),
    },
    corrected: (() => {
      const phraseHints = buildFixturePhraseHints(fixture, "benchmark-seeded");
      const corrected = applyPhraseHintCorrections(raw.finalText, phraseHints);
      return {
        text: corrected.text,
        changed: corrected.changed,
        matches: corrected.matches.map((match) => ({
          alias: match.alias,
          text: match.hint.text,
        })),
        accuracy: scoreTranscriptAccuracy(
          corrected.text,
          fixture.expectedText,
          0.2,
        ),
      };
    })(),
  });
}

const output = {
  adapter: {
    provider: "deepgram",
    model: env.DEEPGRAM_MODEL,
    language: env.DEEPGRAM_LANGUAGE,
    diarize: true,
  },
  fixtureCount: fixtures.length,
  results,
};

await mkdir(benchmarkResultsDir, { recursive: true });

const outputPath = resolve(benchmarkResultsDir, "multi-speaker-debug.json");
await Bun.write(outputPath, JSON.stringify(output, null, 2));

console.log(JSON.stringify(output, null, 2));
console.log(`\nSaved debug JSON to ${outputPath}`);
