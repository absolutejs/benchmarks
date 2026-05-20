import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { deepgram } from "@absolutejs/voice-deepgram";
import { elevenlabs } from "@absolutejs/voice-elevenlabs";
import {
  createDomainLexicon,
  createDomainPhraseHints,
} from "@absolutejs/voice";
import { createVoiceMemoryStore } from "@absolutejs/voice";
import { resolveVoiceRuntimePreset } from "@absolutejs/voice";
import { shapeTelephonyAssistantText } from "@absolutejs/voice";
import { scoreTranscriptAccuracy } from "@absolutejs/voice/testing";
import { loadVoiceTestFixtures } from "@absolutejs/voice/testing";
import {
  createVoiceCallReviewFromLiveTelephonyReport,
  renderVoiceCallReviewMarkdown,
} from "@absolutejs/voice/testing";
import {
  createTwilioMediaStreamBridge,
  transcodePCMToTwilioOutboundPayload,
} from "@absolutejs/voice";
import { loadVoiceTestEnv } from "../test/live/env";
import type {
  AudioChunk,
  STTAdapter,
  STTAdapterOpenOptions,
  STTSessionEventMap,
  TTSAdapter,
  TTSSessionEventMap,
  VoiceDomainTerm,
} from "@absolutejs/voice";

type LiveTelephonyVariantId = "flux-general-en" | "nova-3-phone";

type LiveTelephonyVariant = {
  description: string;
  id: LiveTelephonyVariantId;
  model: string;
};

type LiveTelephonyTraceEvent = {
  atMs: number;
  bytes?: number;
  chunkDurationMs?: number;
  chunkIndex?: number;
  confidence?: number;
  event: string;
  name?: string;
  reason?: string;
  source: "benchmark" | "stt" | "turn" | "twilio";
  text?: string;
  track?: string;
};

type LiveTelephonyBenchmarkResult = {
  actualText: string;
  clearCount: number;
  clearLatencyMs?: number;
  elapsedMs: number;
  errors: string[];
  expectedText: string;
  fixtureId: string;
  firstOutboundMediaLatencyMs?: number;
  firstTurnLatencyMs?: number;
  markCount: number;
  markLatencyMs?: number;
  outboundMediaCount: number;
  passes: boolean;
  termRecall: number;
  title: string;
  turnCount: number;
  wordErrorRate: number;
};

type LiveTelephonyBenchmarkReport = {
  fixtures: LiveTelephonyBenchmarkResult[];
  generatedAt: number;
  summary: {
    averageClearLatencyMs?: number;
    averageFirstOutboundMediaLatencyMs?: number;
    averageFirstTurnLatencyMs?: number;
    averageMarkLatencyMs?: number;
    averageTermRecall: number;
    averageWordErrorRate: number;
    passCount: number;
    passRate: number;
    totalOutboundMediaCount: number;
  };
  ttsConfig: {
    modelId: string;
    optimizeStreamingLatency?: number;
    transport: "http" | "websocket";
    voiceSettings?: {
      similarityBoost?: number;
      speed?: number;
      stability?: number;
      style?: number;
      useSpeakerBoost?: boolean;
    };
  };
  turnDetectionConfig: {
    silenceMs: number;
    speechThreshold: number;
    transcriptStabilityMs: number;
  };
  trace: LiveTelephonyTraceEvent[];
  variant: LiveTelephonyVariant;
};

const variants: Record<LiveTelephonyVariantId, LiveTelephonyVariant> = {
  "flux-general-en": {
    description: "Deepgram Flux English conversational path",
    id: "flux-general-en",
    model: "flux-general-en",
  },
  "nova-3-phone": {
    description: "Deepgram Nova-3 phone-style streaming path",
    id: "nova-3-phone",
    model: "nova-3",
  },
};

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const variantId = (
  process.env.VOICE_TELEPHONY_VARIANT ??
  process.argv[2] ??
  "flux-general-en"
).trim() as LiveTelephonyVariantId;
const variant = variants[variantId];

if (!variant) {
  throw new Error(
    `Unknown live telephony variant "${variantId}". Expected one of: ${Object.keys(variants).join(", ")}`,
  );
}

const outputPath = process.env.VOICE_TELEPHONY_LIVE_OUTPUT
  ? resolve(process.env.VOICE_TELEPHONY_LIVE_OUTPUT)
  : resolve(
      resultsDir,
      variant.id === "flux-general-en"
        ? "telephony-live-deepgram-elevenlabs.json"
        : `telephony-live-${variant.id}.json`,
    );
const reviewJsonPath = outputPath.replace(/\.json$/u, ".review.json");
const reviewMarkdownPath = outputPath.replace(/\.json$/u, ".review.md");
const startedAt = Date.now();

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const scoreTermRecall = (text: string, expectedTerms: string[] | undefined) => {
  const normalizedText = normalizeText(text);
  const normalizedTerms = (expectedTerms ?? [])
    .map((term) => normalizeText(term))
    .filter((term) => term.length > 0);

  if (normalizedTerms.length === 0) {
    return 1;
  }

  const hitCount = normalizedTerms.filter((term) =>
    normalizedText.includes(term),
  ).length;
  return hitCount / normalizedTerms.length;
};

const waitFor = async (
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 20,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await Bun.sleep(intervalMs);
  }

  return check();
};

const chunkPcm16 = (audio: Uint8Array, chunkSizeBytes: number) => {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < audio.byteLength; offset += chunkSizeBytes) {
    chunks.push(
      audio.slice(offset, Math.min(audio.byteLength, offset + chunkSizeBytes)),
    );
  }
  return chunks;
};

const getChunkDurationMs = (
  chunk: Uint8Array,
  sampleRateHz: number,
  channels: number,
) => (chunk.byteLength / (sampleRateHz * channels * 2)) * 1_000;

const createSilencePcm16 = (
  durationMs: number,
  format: {
    channels: number;
    sampleRateHz: number;
  },
) =>
  new Uint8Array(
    Math.max(
      format.channels * 2,
      Math.round(
        (format.sampleRateHz * format.channels * 2 * durationMs) / 1_000,
      ),
    ),
  );

const trimTrailingSilence = (
  audio: Uint8Array,
  format: {
    channels: number;
    sampleRateHz: number;
  },
  threshold = 0.008,
  windowMs = 50,
) => {
  const bytesPerFrame = format.channels * 2;
  const windowBytes = Math.max(
    bytesPerFrame,
    Math.round((format.sampleRateHz * bytesPerFrame * windowMs) / 1_000),
  );
  let end = audio.byteLength;

  while (end > windowBytes) {
    const start = Math.max(0, end - windowBytes);
    const window = audio.slice(start, end);
    const view = new DataView(
      window.buffer,
      window.byteOffset,
      window.byteLength,
    );
    const sampleCount = Math.floor(window.byteLength / 2);
    let sumSquares = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      const sample = view.getInt16(index * 2, true) / 0x8000;
      sumSquares += sample * sample;
    }

    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    if (rms >= threshold) {
      break;
    }

    end = start;
  }

  return audio.slice(0, Math.max(windowBytes, end));
};

const getChunkByteLength = (chunk: AudioChunk) => {
  if (chunk instanceof ArrayBuffer) {
    return chunk.byteLength;
  }

  return chunk.byteLength;
};

const env = await loadVoiceTestEnv();
if (!env.DEEPGRAM_API_KEY) {
  throw new Error(
    "DEEPGRAM_API_KEY is required for live telephony benchmarks.",
  );
}
if (!env.ELEVENLABS_API_KEY) {
  throw new Error(
    "ELEVENLABS_API_KEY is required for live telephony benchmarks.",
  );
}

const baseFixtures = await loadVoiceTestFixtures();
const fixture =
  baseFixtures.find(
    (entry) =>
      entry.difficulty === "clean" &&
      !(entry.tags ?? []).includes("accent") &&
      !(entry.tags ?? []).includes("speech-accent-archive"),
  ) ?? baseFixtures[0];

if (!fixture) {
  throw new Error(
    "No telephony fixtures available for live telephony benchmark.",
  );
}

const domainTerms: VoiceDomainTerm[] = (fixture.expectedTerms ?? []).map(
  (term) => ({
    aliases: [term],
    text: term,
  }),
);
const phraseHints = createDomainPhraseHints(domainTerms, {
  riskTier: "safe",
});
const lexicon = createDomainLexicon(domainTerms);
const trimmedAudio = trimTrailingSilence(fixture.audio, fixture.format);
const silencePadMs = Number(
  process.env.VOICE_TELEPHONY_LIVE_SILENCE_PAD_MS ?? 650,
);
const turnDetectionSilenceMs = process.env.VOICE_TELEPHONY_LIVE_TURN_SILENCE_MS
  ? Number(process.env.VOICE_TELEPHONY_LIVE_TURN_SILENCE_MS)
  : undefined;
const turnDetectionSpeechThreshold = process.env
  .VOICE_TELEPHONY_LIVE_SPEECH_THRESHOLD
  ? Number(process.env.VOICE_TELEPHONY_LIVE_SPEECH_THRESHOLD)
  : undefined;
const turnDetectionTranscriptStabilityMs = process.env
  .VOICE_TELEPHONY_LIVE_TRANSCRIPT_STABILITY_MS
  ? Number(process.env.VOICE_TELEPHONY_LIVE_TRANSCRIPT_STABILITY_MS)
  : undefined;
const ttsOptimizeStreamingLatency = process.env
  .VOICE_TELEPHONY_LIVE_TTS_OPTIMIZE
  ? Number(process.env.VOICE_TELEPHONY_LIVE_TTS_OPTIMIZE)
  : 4;
const ttsModelId =
  process.env.VOICE_TELEPHONY_LIVE_TTS_MODEL?.trim() || "eleven_flash_v2_5";
const telephonyResponseMode =
  (process.env.VOICE_TELEPHONY_RESPONSE_MODE ?? "full").trim() === "full"
    ? "full"
    : "lead-clause";
const ttsTransport =
  (process.env.VOICE_TELEPHONY_LIVE_TTS_TRANSPORT ?? "http").trim() === "http"
    ? "http"
    : "websocket";
const ttsVoiceSettings = {
  similarityBoost: process.env.VOICE_TELEPHONY_LIVE_TTS_SIMILARITY_BOOST
    ? Number(process.env.VOICE_TELEPHONY_LIVE_TTS_SIMILARITY_BOOST)
    : 0.7,
  speed: process.env.VOICE_TELEPHONY_LIVE_TTS_SPEED
    ? Number(process.env.VOICE_TELEPHONY_LIVE_TTS_SPEED)
    : undefined,
  stability: process.env.VOICE_TELEPHONY_LIVE_TTS_STABILITY
    ? Number(process.env.VOICE_TELEPHONY_LIVE_TTS_STABILITY)
    : 0.35,
  style: process.env.VOICE_TELEPHONY_LIVE_TTS_STYLE
    ? Number(process.env.VOICE_TELEPHONY_LIVE_TTS_STYLE)
    : undefined,
  useSpeakerBoost:
    process.env.VOICE_TELEPHONY_LIVE_TTS_USE_SPEAKER_BOOST === undefined
      ? false
      : process.env.VOICE_TELEPHONY_LIVE_TTS_USE_SPEAKER_BOOST === "true",
} as const;
const telephonyPresetName = "pstn-balanced" as const;
const runtimePreset = resolveVoiceRuntimePreset(telephonyPresetName);
const effectiveTurnDetectionConfig = {
  ...runtimePreset.turnDetection,
  ...(turnDetectionSilenceMs !== undefined
    ? { silenceMs: turnDetectionSilenceMs }
    : {}),
  ...(turnDetectionSpeechThreshold !== undefined
    ? { speechThreshold: turnDetectionSpeechThreshold }
    : {}),
  ...(turnDetectionTranscriptStabilityMs !== undefined
    ? { transcriptStabilityMs: turnDetectionTranscriptStabilityMs }
    : {}),
};

const trace: LiveTelephonyTraceEvent[] = [];
const errors: string[] = [];
const benchmarkStartedAt = Date.now();
const pushTrace = (
  source: LiveTelephonyTraceEvent["source"],
  event: string,
  fields: Omit<LiveTelephonyTraceEvent, "atMs" | "event" | "source"> = {},
) => {
  trace.push({
    atMs: Date.now() - benchmarkStartedAt,
    event,
    source,
    ...fields,
  });
};

const createVariantSttAdapter = (
  selectedVariant: LiveTelephonyVariant,
): STTAdapter<STTAdapterOpenOptions> => {
  const baseAdapter =
    selectedVariant.id === "nova-3-phone"
      ? deepgram({
          apiKey: env.DEEPGRAM_API_KEY,
          connectTimeoutMs: 12_000,
          endpointing: false,
          interimResults: true,
          keyterms: fixture.expectedTerms,
          language: "en",
          model: "nova-3",
          punctuate: true,
          smartFormat: true,
          utteranceEndMs: 900,
          vadEvents: true,
        })
      : deepgram({
          apiKey: env.DEEPGRAM_API_KEY,
          connectTimeoutMs: 12_000,
          eagerEotThreshold: 0.8,
          eotThreshold: 0.82,
          eotTimeoutMs: 1_200,
          keyterms: fixture.expectedTerms,
          model: "flux-general-en",
        });

  return {
    kind: "stt",
    open: async (options) => {
      pushTrace("benchmark", "stt-open", {
        reason: selectedVariant.id,
        text: options.sessionId,
      });
      const session = await baseAdapter.open(options);

      return {
        close: async (reason) => {
          pushTrace("benchmark", "stt-close", { reason });
          await session.close(reason);
        },
        on: (event, handler) =>
          session.on(event, async (payload) => {
            switch (event) {
              case "partial":
              case "final":
                pushTrace("stt", event, {
                  confidence: payload.transcript.confidence,
                  text: payload.transcript.text,
                });
                break;
              case "endOfTurn":
                pushTrace("stt", "endOfTurn", {
                  reason: payload.reason,
                });
                break;
              case "error":
                pushTrace("stt", "error", {
                  reason: payload.error.message,
                });
                break;
              case "close":
                pushTrace("stt", "close", {
                  reason: payload.reason,
                });
                break;
            }

            await handler(payload as STTSessionEventMap[typeof event]);
          }),
        send: async (audio) => {
          pushTrace("benchmark", "stt-send", {
            bytes: getChunkByteLength(audio),
          });
          await session.send(audio);
        },
      };
    },
  };
};

const createInstrumentedTTSAdapter = (): TTSAdapter => {
  const baseAdapter = elevenlabs({
    apiKey: env.ELEVENLABS_API_KEY,
    languageCode: "en",
    modelId: ttsModelId,
    optimizeStreamingLatency:
      ttsOptimizeStreamingLatency >= 0 && ttsOptimizeStreamingLatency <= 4
        ? (ttsOptimizeStreamingLatency as 0 | 1 | 2 | 3 | 4)
        : undefined,
    outputFormat: "ulaw_8000",
    transport: ttsTransport,
    voiceId: env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb",
    voiceSettings: Object.values(ttsVoiceSettings).some(
      (value) => value !== undefined,
    )
      ? { ...ttsVoiceSettings }
      : undefined,
    websocket:
      ttsTransport === "websocket"
        ? {
            autoMode: true,
            inactivityTimeoutSec: 180,
          }
        : undefined,
  });

  return {
    kind: "tts",
    open: async (options) => {
      pushTrace("benchmark", "tts-open", {
        reason: `${ttsTransport}-${ttsModelId}-${
          ttsOptimizeStreamingLatency >= 0 && ttsOptimizeStreamingLatency <= 4
            ? `opt-${ttsOptimizeStreamingLatency}`
            : "default"
        }`,
      });
      const session = await baseAdapter.open(options);
      let sawFirstAudio = false;

      return {
        close: async (reason) => {
          pushTrace("benchmark", "tts-close", { reason });
          await session.close(reason);
        },
        on: (event, handler) =>
          session.on(event, async (payload) => {
            if (event === "audio") {
              const audioPayload = payload as TTSSessionEventMap["audio"];
              pushTrace(
                "benchmark",
                sawFirstAudio ? "tts-audio" : "tts-first-audio",
                {
                  bytes: getChunkByteLength(audioPayload.chunk),
                },
              );
              sawFirstAudio = true;
            }

            if (event === "error") {
              const errorPayload = payload as TTSSessionEventMap["error"];
              pushTrace("benchmark", "tts-error", {
                reason: errorPayload.error.message,
              });
            }

            if (event === "close") {
              const closePayload = payload as TTSSessionEventMap["close"];
              pushTrace("benchmark", "tts-session-close", {
                reason: closePayload.reason,
              });
            }

            await handler(payload as TTSSessionEventMap[typeof event]);
          }),
        send: async (text) => {
          pushTrace("benchmark", "tts-send", {
            text,
          });
          await session.send(text);
        },
      };
    },
  };
};

const sentEvents: Array<{ at: number; event: Record<string, unknown> }> = [];
const committedTurnTexts: string[] = [];
let secondInboundAt: number | undefined;
let firstTurnCommittedAt: number | undefined;
let turnCommittedAt: number | undefined;

const bridge = createTwilioMediaStreamBridge(
  {
    close: () => {},
    send: (data) => {
      const event = JSON.parse(data) as Record<string, unknown>;
      sentEvents.push({
        at: Date.now(),
        event,
      });

      const eventName =
        typeof event.event === "string" ? event.event : "unknown";
      pushTrace("twilio", eventName, {
        bytes:
          eventName === "media" &&
          typeof event.media === "object" &&
          event.media !== null &&
          typeof (event.media as { payload?: string }).payload === "string"
            ? (event.media as { payload: string }).payload.length
            : undefined,
        name:
          eventName === "mark" &&
          typeof event.mark === "object" &&
          event.mark !== null &&
          typeof (event.mark as { name?: string }).name === "string"
            ? (event.mark as { name: string }).name
            : undefined,
      });
    },
  },
  {
    context: {},
    languageStrategy: {
      mode: "fixed",
      primaryLanguage: "en",
    },
    lexicon,
    onComplete: async () => {},
    onError: async ({ error }) => {
      errors.push(error.message);
      pushTrace("turn", "error", {
        reason: error.message,
      });
    },
    onTurn: async ({ turn }) => {
      committedTurnTexts.push(turn.text);
      if (firstTurnCommittedAt === undefined) {
        firstTurnCommittedAt = Date.now();
      }
      turnCommittedAt = Date.now();
      pushTrace("turn", "commit", {
        confidence: turn.quality?.averageConfidence,
        text: turn.text,
      });
      const assistantText = shapeTelephonyAssistantText(
        `You said: ${turn.text}`,
        {
          maxWords: 10,
          mode: telephonyResponseMode,
        },
      );
      pushTrace("turn", "assistant-shape", {
        reason: telephonyResponseMode,
        text: assistantText,
      });
      return {
        assistantText,
      };
    },
    phraseHints,
    preset: telephonyPresetName,
    session: createVoiceMemoryStore(),
    stt: createVariantSttAdapter(variant),
    tts: createInstrumentedTTSAdapter(),
    turnDetection: effectiveTurnDetectionConfig,
  },
);

try {
  await mkdir(resultsDir, { recursive: true });
  await rm(outputPath, { force: true });
  pushTrace("benchmark", "start", {
    reason: variant.id,
    text: fixture.id,
  });

  await bridge.handleMessage({
    event: "start",
    start: {
      callSid: "CA-live-benchmark",
      customParameters: {
        scenarioId: fixture.id,
        sessionId: `live-phone-${fixture.id}`,
      },
      streamSid: "MZ-live-benchmark",
    },
    streamSid: "MZ-live-benchmark",
  });

  const chunkSizeBytes = Math.max(
    320,
    Math.round(
      (fixture.format.sampleRateHz * fixture.format.channels * 2 * 20) / 1_000,
    ),
  );
  const inboundChunks = chunkPcm16(trimmedAudio, chunkSizeBytes);

  for (const [chunkIndex, chunk] of inboundChunks.entries()) {
    const chunkDurationMs = Math.max(
      10,
      Math.round(
        getChunkDurationMs(
          chunk,
          fixture.format.sampleRateHz,
          fixture.format.channels,
        ),
      ),
    );
    pushTrace("benchmark", "inbound-media", {
      bytes: chunk.byteLength,
      chunkDurationMs,
      chunkIndex,
      track: "inbound",
    });
    await bridge.handleMessage({
      event: "media",
      media: {
        payload: transcodePCMToTwilioOutboundPayload(chunk, fixture.format),
        track: "inbound",
      },
      streamSid: "MZ-live-benchmark",
    });
    await Bun.sleep(chunkDurationMs);
  }

  const silencePad = createSilencePcm16(silencePadMs, fixture.format);
  const silenceChunks = chunkPcm16(silencePad, chunkSizeBytes);

  for (const [silenceIndex, chunk] of silenceChunks.entries()) {
    const chunkDurationMs = Math.max(
      10,
      Math.round(
        getChunkDurationMs(
          chunk,
          fixture.format.sampleRateHz,
          fixture.format.channels,
        ),
      ),
    );
    pushTrace("benchmark", "inbound-silence-pad", {
      bytes: chunk.byteLength,
      chunkDurationMs,
      chunkIndex: silenceIndex,
      track: "inbound",
    });
    await bridge.handleMessage({
      event: "media",
      media: {
        payload: transcodePCMToTwilioOutboundPayload(chunk, fixture.format),
        track: "inbound",
      },
      streamSid: "MZ-live-benchmark",
    });
    await Bun.sleep(chunkDurationMs);
  }

  const sawOutboundMedia = await waitFor(
    () =>
      sentEvents.some(
        (entry) => (entry.event.event as string | undefined) === "media",
      ),
    15_000,
  );
  if (!sawOutboundMedia) {
    throw new Error(
      "Live telephony benchmark did not emit Twilio media in time.",
    );
  }

  secondInboundAt = Date.now();
  pushTrace("benchmark", "barge-in", {
    bytes: 8,
    track: "inbound",
  });
  await bridge.handleMessage({
    event: "media",
    media: {
      payload: transcodePCMToTwilioOutboundPayload(
        new Uint8Array([200, 0, 56, 255, 200, 0, 56, 255]),
        {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16_000,
        },
      ),
      track: "inbound",
    },
    streamSid: "MZ-live-benchmark",
  });

  await waitFor(
    () =>
      sentEvents.some(
        (entry) => (entry.event.event as string | undefined) === "clear",
      ),
    5_000,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  pushTrace("benchmark", "error", {
    reason: message,
  });
} finally {
  pushTrace("benchmark", "close");
  await bridge.close("live-telephony-benchmark");
}

const outboundMediaEvents = sentEvents.filter(
  (entry) => (entry.event.event as string | undefined) === "media",
);
const markEvents = sentEvents.filter(
  (entry) => (entry.event.event as string | undefined) === "mark",
);
const clearEvents = sentEvents.filter(
  (entry) => (entry.event.event as string | undefined) === "clear",
);
const firstPostBargeInClear = clearEvents.find(
  (entry) => secondInboundAt !== undefined && entry.at >= secondInboundAt,
);
const actualText = committedTurnTexts.join(" ").trim();
const accuracy = scoreTranscriptAccuracy(
  actualText,
  fixture.expectedText,
  0.45,
);
const termRecall = scoreTermRecall(actualText, fixture.expectedTerms);

const result: LiveTelephonyBenchmarkResult = {
  actualText,
  clearCount: clearEvents.length,
  clearLatencyMs:
    secondInboundAt !== undefined && firstPostBargeInClear?.at !== undefined
      ? firstPostBargeInClear.at - secondInboundAt
      : undefined,
  elapsedMs: Date.now() - benchmarkStartedAt,
  errors,
  expectedText: fixture.expectedText,
  fixtureId: fixture.id,
  firstOutboundMediaLatencyMs:
    outboundMediaEvents[0]?.at !== undefined
      ? outboundMediaEvents[0].at - benchmarkStartedAt
      : undefined,
  firstTurnLatencyMs:
    firstTurnCommittedAt !== undefined
      ? firstTurnCommittedAt - benchmarkStartedAt
      : undefined,
  markCount: markEvents.length,
  markLatencyMs:
    markEvents[0]?.at !== undefined
      ? markEvents[0].at - benchmarkStartedAt
      : undefined,
  outboundMediaCount: outboundMediaEvents.length,
  passes:
    errors.length === 0 &&
    accuracy.passesThreshold &&
    outboundMediaEvents.length > 0 &&
    markEvents.length > 0 &&
    clearEvents.length > 0,
  termRecall,
  title: fixture.title,
  turnCount: committedTurnTexts.length,
  wordErrorRate: accuracy.wordErrorRate,
};

const report: LiveTelephonyBenchmarkReport = {
  fixtures: [result],
  generatedAt: Date.now(),
  summary: {
    averageClearLatencyMs: result.clearLatencyMs,
    averageFirstOutboundMediaLatencyMs: result.firstOutboundMediaLatencyMs,
    averageFirstTurnLatencyMs: result.firstTurnLatencyMs,
    averageMarkLatencyMs: result.markLatencyMs,
    averageTermRecall: result.termRecall,
    averageWordErrorRate: result.wordErrorRate,
    passCount: result.passes ? 1 : 0,
    passRate: result.passes ? 1 : 0,
    totalOutboundMediaCount: result.outboundMediaCount,
  },
  ttsConfig: {
    modelId: ttsModelId,
    optimizeStreamingLatency:
      ttsOptimizeStreamingLatency >= 0 && ttsOptimizeStreamingLatency <= 4
        ? ttsOptimizeStreamingLatency
        : undefined,
    transport: ttsTransport,
    voiceSettings: Object.values(ttsVoiceSettings).some(
      (value) => value !== undefined,
    )
      ? { ...ttsVoiceSettings }
      : undefined,
  },
  turnDetectionConfig: {
    silenceMs: effectiveTurnDetectionConfig.silenceMs,
    speechThreshold: effectiveTurnDetectionConfig.speechThreshold,
    transcriptStabilityMs: effectiveTurnDetectionConfig.transcriptStabilityMs,
  },
  trace,
  variant,
};

await Bun.write(outputPath, JSON.stringify(report, null, 2));
const metadata = await stat(outputPath);
if (metadata.mtimeMs < startedAt) {
  throw new Error(
    `Stale live telephony benchmark output detected: ${outputPath}`,
  );
}

const review = createVoiceCallReviewFromLiveTelephonyReport(report, {
  path: outputPath,
  preset: telephonyPresetName,
});
await Bun.write(reviewJsonPath, JSON.stringify(review, null, 2));
await Bun.write(reviewMarkdownPath, renderVoiceCallReviewMarkdown(review));

console.log(`Saved live telephony benchmark JSON to ${outputPath}`);
