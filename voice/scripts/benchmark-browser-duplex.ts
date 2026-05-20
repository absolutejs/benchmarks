import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { elevenlabs } from "@absolutejs/voice-elevenlabs";
import { openai } from "@absolutejs/voice-openai";
import type { RealtimeAdapter, TTSAdapter } from "@absolutejs/voice";
import { loadVoiceTestEnv } from "../test/live/env";

type BrowserDuplexFixtureResult = {
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

type BrowserDuplexBenchmarkReport = {
  fixtures: BrowserDuplexFixtureResult[];
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

type BrowserMessage =
  | { type: "ready" }
  | { type: "playback-started"; at: number }
  | {
      type: "interrupt-complete";
      completedAt: number;
      interruptLatencyMs?: number;
      latencyMs?: number;
      requestedAt: number;
    }
  | { type: "error"; error: string };

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    reject,
    resolve,
  } satisfies Deferred<T>;
};

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");
const target = (process.argv[2] ?? "all").trim().toLowerCase();
const variantFlagIndex = process.argv.indexOf("--variant");
const variant =
  variantFlagIndex >= 0
    ? (process.argv[variantFlagIndex + 1] ?? "").trim()
    : "";
const supportedTargets = new Set(["all", "elevenlabs", "openai"]);
const startedAt = Date.now();
const clientBundlePath = resolve(projectRoot, "dist", "client", "index.js");

if (!supportedTargets.has(target)) {
  throw new Error(
    `Unsupported browser duplex benchmark target "${target}". Use one of: ${[
      ...supportedTargets,
    ].join(", ")}`,
  );
}

const resolveOutputPath = (nextTarget: string) =>
  resolve(
    resultsDir,
    `duplex-browser-${nextTarget}${variant ? `-${variant}` : ""}.json`,
  );

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

const createHarnessHtml = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AbsoluteJS Browser Duplex Benchmark</title>
</head>
<body>
  <script type="module">
    import { createVoiceAudioPlayer } from '/client/index.js';

    const assistantAudio = [];
    const subscribers = new Set();
    const source = {
      get assistantAudio() {
        return assistantAudio;
      },
      subscribe(subscriber) {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      }
    };

    const push = (chunk) => {
      assistantAudio.push(chunk);
      for (const subscriber of subscribers) {
        subscriber();
      }
    };

    const decodeBase64 = (value) => {
      const binary = atob(value);
      const output = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        output[index] = binary.charCodeAt(index);
      }
      return output;
    };

    const ws = new WebSocket(\`ws://\${location.host}/ws\`);
    const player = createVoiceAudioPlayer(source, {
      lookaheadMs: 15
    });
    let didReportPlaybackStart = false;

    player.subscribe(() => {
      if (!didReportPlaybackStart && player.activeSourceCount > 0) {
        didReportPlaybackStart = true;
        ws.send(JSON.stringify({
          type: 'playback-started',
          at: performance.now()
        }));
      }
    });

    ws.addEventListener('open', async () => {
      try {
        await player.start();
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    });

    ws.addEventListener('message', async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'audio') {
        push({
          chunk: decodeBase64(message.chunkBase64),
          format: message.format,
          receivedAt: message.receivedAt,
          turnId: message.turnId
        });
        return;
      }

      if (message.type === 'interrupt') {
        const requestedAt = performance.now();
        await player.interrupt();
        ws.send(JSON.stringify({
          type: 'interrupt-complete',
          requestedAt,
          completedAt: performance.now(),
          latencyMs: player.lastPlaybackStopLatencyMs,
          interruptLatencyMs: player.lastInterruptLatencyMs
        }));
        return;
      }

      if (message.type === 'shutdown') {
        await player.close();
        ws.close();
      }
    });
  </script>
</body>
</html>`;

const summarize = (
  fixtures: BrowserDuplexFixtureResult[],
): BrowserDuplexBenchmarkReport["summary"] => {
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

const benchmarkAdapter = async (
  adapterId: string,
  adapter: TTSAdapter | RealtimeAdapter,
): Promise<BrowserDuplexFixtureResult> => {
  const errors: string[] = [];
  let audioChunkCount = 0;
  let closed = false;
  let firstAudioAt: number | undefined;
  let interruptRequestedAt: number | undefined;
  let playbackStopLatencyMs: number | undefined;
  let postInterruptAudioBytes = 0;
  let preInterruptAudioBytes = 0;
  let sessionClosedAt: number | undefined;
  let totalAudioBytes = 0;
  const startedAt = Date.now();

  const readyDeferred = createDeferred<void>();
  const playbackDeferred = createDeferred<number>();
  const interruptDeferred = createDeferred<number | undefined>();
  let browserSocket: Bun.ServerWebSocket<unknown> | null = null;

  const server = Bun.serve({
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(request)) {
          return undefined;
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      if (url.pathname === "/client/index.js") {
        return new Response(Bun.file(clientBundlePath), {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
          },
        });
      }

      if (url.pathname === "/") {
        return new Response(createHarnessHtml(), {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      close() {
        browserSocket = null;
      },
      message(_ws, rawMessage) {
        try {
          const message = JSON.parse(String(rawMessage)) as BrowserMessage;
          if (message.type === "ready") {
            readyDeferred.resolve();
            return;
          }

          if (message.type === "playback-started") {
            playbackDeferred.resolve(message.at);
            return;
          }

          if (message.type === "interrupt-complete") {
            playbackStopLatencyMs = message.latencyMs;
            interruptDeferred.resolve(message.latencyMs);
            return;
          }

          if (message.type === "error") {
            errors.push(message.error);
            readyDeferred.reject(new Error(message.error));
            playbackDeferred.reject(new Error(message.error));
            interruptDeferred.reject(new Error(message.error));
          }
        } catch (error) {
          const nextError =
            error instanceof Error ? error.message : String(error);
          errors.push(nextError);
          readyDeferred.reject(error);
          playbackDeferred.reject(error);
          interruptDeferred.reject(error);
        }
      },
      open(ws) {
        browserSocket = ws;
      },
    },
  });

  const chrome = Bun.spawn({
    cmd: [
      "google-chrome",
      "--headless=new",
      "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
      `http://127.0.0.1:${server.port}/?adapter=${adapterId}&run=${Date.now()}`,
    ],
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const session =
    adapter.kind === "realtime"
      ? await adapter.open({
          format: {
            channels: 1,
            container: "raw",
            encoding: "pcm_s16le",
            sampleRateHz: 24_000,
          },
          sessionId: `duplex-browser:${adapterId}`,
        })
      : await adapter.open({
          sessionId: `duplex-browser:${adapterId}`,
        });

  const unsubscribers = [
    session.on("audio", ({ chunk, format, receivedAt, turnId }) => {
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
      browserSocket?.send(
        JSON.stringify({
          type: "audio",
          chunkBase64: Buffer.from(normalized).toString("base64"),
          format,
          receivedAt,
          turnId,
        }),
      );
    }),
    session.on("close", () => {
      closed = true;
      sessionClosedAt = Date.now();
    }),
    session.on("error", (event) => {
      errors.push(event.error.message);
    }),
  ];

  try {
    await Promise.race([
      readyDeferred.promise,
      Bun.sleep(8_000).then(() => {
        throw new Error(
          `Browser harness did not become ready for ${adapterId}`,
        );
      }),
    ]);

    await session.send(LONG_TEXT);

    await Promise.race([
      playbackDeferred.promise,
      Bun.sleep(8_000).then(() => {
        throw new Error(
          `Browser playback did not start in time for ${adapterId}`,
        );
      }),
    ]);

    preInterruptAudioBytes = totalAudioBytes;
    interruptRequestedAt = Date.now();
    browserSocket?.send(JSON.stringify({ type: "interrupt" }));
    await session.close("barge-in");

    await Promise.race([
      interruptDeferred.promise,
      Bun.sleep(4_000).then(() => {
        throw new Error(
          `Browser playback did not stop in time after barge-in for ${adapterId}`,
        );
      }),
    ]);

    await waitFor(() => closed, 2_000);
  } finally {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }

    browserSocket?.send(JSON.stringify({ type: "shutdown" }));
    if (!closed) {
      await session.close("browser duplex benchmark cleanup");
    }

    server.stop(true);
    chrome.kill();
    await chrome.exited.catch(() => undefined);
  }

  return {
    adapterId,
    audioChunkCount,
    errors,
    firstAudioLatencyMs:
      firstAudioAt !== undefined ? firstAudioAt - startedAt : undefined,
    playbackStopLatencyMs,
    postInterruptAudioBytes,
    preInterruptAudioBytes,
    passes:
      errors.length === 0 &&
      audioChunkCount > 0 &&
      postInterruptAudioBytes === 0 &&
      typeof playbackStopLatencyMs === "number",
    sessionCloseLatencyMs:
      interruptRequestedAt !== undefined && sessionClosedAt !== undefined
        ? sessionClosedAt - interruptRequestedAt
        : undefined,
    totalAudioBytes,
    triggerMode: "input-level",
  };
};

const env = await loadVoiceTestEnv();
const reports: BrowserDuplexBenchmarkReport[] = [];

await mkdir(resultsDir, { recursive: true });
await rm(resolveOutputPath(target), { force: true });

if (target === "all" || target === "elevenlabs") {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is required for browser duplex benchmarks.",
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
    throw new Error(
      "OPENAI_API_KEY is required for browser duplex benchmarks.",
    );
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
  throw new Error(
    `Stale browser duplex benchmark output detected: ${outputPath}`,
  );
}

console.log(`Saved browser duplex benchmark JSON to ${outputPath}`);
