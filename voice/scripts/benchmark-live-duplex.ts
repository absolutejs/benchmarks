import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { elevenlabs } from "@absolutejs/voice-elevenlabs";
import { openai } from "@absolutejs/voice-openai";
import { createVoiceAudioPlayer } from "@absolutejs/voice/client";
import { bindVoiceBargeIn } from "@absolutejs/voice/client";
import type {
  RealtimeAdapter,
  TTSAdapter,
  VoiceAudioPlayerSource,
  VoiceStreamState,
} from "@absolutejs/voice";
import { loadVoiceTestEnv } from "../test/live/env";

type LiveDuplexFixtureResult = {
  adapterId: string;
  audioChunkCount: number;
  errors: string[];
  firstAudioLatencyMs?: number;
  playbackStopLatencyMs?: number;
  postInterruptAudioBytes: number;
  preInterruptAudioBytes: number;
  passes: boolean;
  sessionCloseLatencyMs?: number;
  totalAudioBytes: number;
  triggerMode: "input-level";
};

type LiveDuplexBenchmarkReport = {
  fixtures: LiveDuplexFixtureResult[];
  generatedAt: number;
  summary: {
    averageFirstAudioLatencyMs?: number;
    averagePlaybackStopLatencyMs?: number;
    averageSessionCloseLatencyMs?: number;
    passCount: number;
    passRate: number;
    totalAudioBytes: number;
  };
};

class FakeAudioBuffer implements MinimalAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(
    public readonly numberOfChannels: number,
    public readonly length: number,
    public readonly sampleRate: number,
  ) {
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
    this.duration = length / sampleRate;
  }

  getChannelData(channel: number) {
    return this.channels[channel]!;
  }
}

class FakeAudioBufferSourceNode {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;

  connect() {}
  disconnect() {}
  start() {}
  stop() {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 1;
  destination = {};
  state: "closed" | "running" | "suspended" = "suspended";

  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }

  createBufferSource() {
    return new FakeAudioBufferSourceNode();
  }

  async resume() {
    this.state = "running";
  }

  async suspend() {
    this.state = "suspended";
  }

  async close() {
    this.state = "closed";
  }
}

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const target = (process.argv[2] ?? "all").trim().toLowerCase();
const supportedTargets = new Set(["all", "elevenlabs", "openai"]);
const startedAt = Date.now();

if (!supportedTargets.has(target)) {
  throw new Error(
    `Unsupported live duplex benchmark target "${target}". Use one of: ${[
      ...supportedTargets,
    ].join(", ")}`,
  );
}

const resolveOutputPath = (nextTarget: string) =>
  resolve(resultsDir, `duplex-live-${nextTarget}.json`);

const createSource = () => {
  let assistantAudio: VoiceStreamState["assistantAudio"] = [];
  const subscribers = new Set<() => void>();

  const source: VoiceAudioPlayerSource = {
    get assistantAudio() {
      return assistantAudio;
    },
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };

  return {
    push: (chunk: VoiceStreamState["assistantAudio"][number]) => {
      assistantAudio = [...assistantAudio, chunk];
      for (const subscriber of subscribers) {
        subscriber();
      }
    },
    source,
  };
};

const createFakeController = () => {
  return {
    partial: "",
    sendAudio: () => {},
    subscribe: (subscriber: () => void) => {
      void subscriber;
      return () => {};
    },
  };
};

const waitFor = async (
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
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

const LONG_TEXT =
  "Thanks for calling AbsoluteJS support. I found your migration notes, your deployment record, and the follow-up checklist. Please listen carefully because I am about to read the updated handoff details and the next steps for your team.";

const benchmarkAdapter = async (
  adapterId: string,
  adapter: TTSAdapter | RealtimeAdapter,
): Promise<LiveDuplexFixtureResult> => {
  const source = createSource();
  const controller = createFakeController();
  const fakeAudioContext = new FakeAudioContext();
  const player = createVoiceAudioPlayer(source.source, {
    createAudioContext: () => fakeAudioContext as never,
  });
  const binding = bindVoiceBargeIn(controller as never, player, {
    interruptThreshold: 0.08,
  });
  const errors: string[] = [];
  let audioChunkCount = 0;
  let closed = false;
  let firstAudioAt: number | undefined;
  let interruptRequestedAt: number | undefined;
  let sessionClosedAt: number | undefined;
  let postInterruptAudioBytes = 0;
  let preInterruptAudioBytes = 0;
  let totalAudioBytes = 0;
  const startedAt = Date.now();

  const session =
    adapter.kind === "realtime"
      ? await adapter.open({
          format: {
            channels: 1,
            container: "raw",
            encoding: "pcm_s16le",
            sampleRateHz: 24000,
          },
          sessionId: `duplex-live:${adapterId}`,
        })
      : await adapter.open({
          sessionId: `duplex-live:${adapterId}`,
        });

  const unsubscribers = [
    session.on("audio", ({ chunk, format, receivedAt }) => {
      const normalized =
        chunk instanceof Uint8Array
          ? chunk
          : chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      audioChunkCount += 1;
      totalAudioBytes += normalized.byteLength;
      if (interruptRequestedAt !== undefined) {
        postInterruptAudioBytes += normalized.byteLength;
      }

      firstAudioAt ??= receivedAt;
      source.push({
        chunk: normalized,
        format,
        receivedAt,
      });
    }),
    session.on("error", (event) => {
      errors.push(event.error.message);
    }),
    session.on("close", () => {
      closed = true;
      sessionClosedAt = Date.now();
    }),
  ];

  try {
    await player.start();
    await session.send(LONG_TEXT);

    const gotFirstAudio = await waitFor(
      () => player.activeSourceCount > 0,
      8_000,
    );
    if (!gotFirstAudio) {
      throw new Error(`${adapterId} did not produce playable audio in time`);
    }

    preInterruptAudioBytes = totalAudioBytes;
    interruptRequestedAt = Date.now();
    binding.handleLevel(0.2);
    await session.close("barge-in");

    const flushed = await waitFor(
      () => player.activeSourceCount === 0 && player.isPlaying === false,
      2_000,
    );
    if (!flushed) {
      throw new Error(`${adapterId} playback did not flush after barge-in`);
    }

    await waitFor(() => closed, 2_000);
  } finally {
    binding.close();
    await player.close();
    if (!closed) {
      await session.close("live duplex benchmark cleanup");
    }
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  }

  return {
    adapterId,
    audioChunkCount,
    errors,
    firstAudioLatencyMs:
      firstAudioAt !== undefined ? firstAudioAt - startedAt : undefined,
    playbackStopLatencyMs:
      interruptRequestedAt !== undefined
        ? player.lastPlaybackStopLatencyMs
        : undefined,
    postInterruptAudioBytes,
    preInterruptAudioBytes,
    passes:
      errors.length === 0 &&
      audioChunkCount > 0 &&
      postInterruptAudioBytes === 0 &&
      typeof player.lastInterruptLatencyMs === "number",
    sessionCloseLatencyMs:
      interruptRequestedAt !== undefined && sessionClosedAt !== undefined
        ? sessionClosedAt - interruptRequestedAt
        : undefined,
    totalAudioBytes,
    triggerMode: "input-level",
  };
};

const summarize = (
  fixtures: LiveDuplexFixtureResult[],
): LiveDuplexBenchmarkReport["summary"] => {
  const passCount = fixtures.filter((fixture) => fixture.passes).length;
  const firstAudioSamples = fixtures.filter(
    (fixture) => typeof fixture.firstAudioLatencyMs === "number",
  );
  const playbackSamples = fixtures.filter(
    (fixture) => typeof fixture.playbackStopLatencyMs === "number",
  );
  const closeSamples = fixtures.filter(
    (fixture) => typeof fixture.sessionCloseLatencyMs === "number",
  );

  return {
    averageFirstAudioLatencyMs:
      firstAudioSamples.length > 0
        ? firstAudioSamples.reduce(
            (sum, fixture) => sum + fixture.firstAudioLatencyMs!,
            0,
          ) / firstAudioSamples.length
        : undefined,
    averagePlaybackStopLatencyMs:
      playbackSamples.length > 0
        ? playbackSamples.reduce(
            (sum, fixture) => sum + fixture.playbackStopLatencyMs!,
            0,
          ) / playbackSamples.length
        : undefined,
    averageSessionCloseLatencyMs:
      closeSamples.length > 0
        ? closeSamples.reduce(
            (sum, fixture) => sum + fixture.sessionCloseLatencyMs!,
            0,
          ) / closeSamples.length
        : undefined,
    passCount,
    passRate: fixtures.length > 0 ? passCount / fixtures.length : 0,
    totalAudioBytes: fixtures.reduce(
      (sum, fixture) => sum + fixture.totalAudioBytes,
      0,
    ),
  };
};

const env = await loadVoiceTestEnv();
const reports: LiveDuplexBenchmarkReport[] = [];

await mkdir(resultsDir, { recursive: true });
await rm(resolveOutputPath(target), { force: true });

if (target === "all" || target === "elevenlabs") {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is required for live duplex benchmarks.",
    );
  }

  const fixture = await benchmarkAdapter(
    "elevenlabs",
    elevenlabs({
      apiKey: env.ELEVENLABS_API_KEY,
      modelId: "eleven_flash_v2_5",
      outputFormat: "pcm_16000",
      voiceId: env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb",
    }),
  );
  reports.push({
    fixtures: [fixture],
    generatedAt: Date.now(),
    summary: summarize([fixture]),
  });
}

if (target === "all" || target === "openai") {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for live duplex benchmarks.");
  }

  const fixture = await benchmarkAdapter(
    "openai",
    openai({
      apiKey: env.OPENAI_API_KEY,
      model: "gpt-realtime-mini",
      responseMode: "audio",
      voice: "marin",
    }),
  );
  reports.push({
    fixtures: [fixture],
    generatedAt: Date.now(),
    summary: summarize([fixture]),
  });
}

const output =
  target === "all"
    ? {
        generatedAt: Date.now(),
        reports,
      }
    : reports[0];

const outputPath = resolveOutputPath(target);
await Bun.write(outputPath, JSON.stringify(output, null, 2));

const metadata = await stat(outputPath);
if (metadata.mtimeMs < startedAt) {
  throw new Error(`Stale live duplex benchmark output detected: ${outputPath}`);
}

console.log(`Saved live duplex benchmark JSON to ${outputPath}`);
