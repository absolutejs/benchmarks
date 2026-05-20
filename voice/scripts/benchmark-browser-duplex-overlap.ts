import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { elevenlabs } from "@absolutejs/voice-elevenlabs";
import { openai } from "@absolutejs/voice-openai";
import type { RealtimeAdapter, TTSAdapter } from "@absolutejs/voice";
import { loadVoiceTestEnv } from "../test/live/env";

type BrowserDuplexOverlapTurnResult = {
  audioChunkCount: number;
  firstAudioLatencyMs?: number;
  pass: boolean;
  playbackStopLatencyMs?: number;
  postInterruptAudioBytes: number;
  preInterruptAudioBytes: number;
  sessionCloseLatencyMs?: number;
  totalAudioBytes: number;
  turnId: string;
};

type BrowserDuplexOverlapFixtureResult = {
  adapterId: string;
  errors: string[];
  passes: boolean;
  turnPassRate: number;
  turns: BrowserDuplexOverlapTurnResult[];
};

type BrowserDuplexOverlapBenchmarkReport = {
  fixtures: BrowserDuplexOverlapFixtureResult[];
  generatedAt: number;
  summary: {
    averageFirstAudioLatencyMs?: number;
    averagePlaybackStopLatencyMs?: number;
    averageSessionCloseLatencyMs?: number;
    fixturePassCount: number;
    fixturePassRate: number;
    totalTurns: number;
    turnPassRate: number;
  };
};

type BrowserMessage =
  | { type: "ready" }
  | { type: "playback-started"; at: number; turnId: string }
  | {
      type: "interrupt-complete";
      completedAt: number;
      latencyMs?: number;
      requestedAt: number;
      turnId: string;
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
    `Unsupported browser duplex overlap target "${target}". Use one of: ${[
      ...supportedTargets,
    ].join(", ")}`,
  );
}

const resolveOutputPath = (nextTarget: string) =>
  resolve(
    resultsDir,
    `duplex-browser-overlap-${nextTarget}${variant ? `-${variant}` : ""}.json`,
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

const TURN_TEXTS = [
  {
    text: "Thanks for calling AbsoluteJS support. I found your migration notes and the next deployment checklist for the team.",
    turnId: "turn-1",
  },
  {
    text: "The rollback note says the API gateway change should be verified before the database migration is retried.",
    turnId: "turn-2",
  },
  {
    text: "Please also tell the on-call engineer that the customer wants a written status update before noon.",
    turnId: "turn-3",
  },
];

const createHarnessHtml = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AbsoluteJS Browser Duplex Overlap Benchmark</title>
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
    let currentTurnId = null;
    let didReportPlaybackStart = false;

    player.subscribe(() => {
      if (!didReportPlaybackStart && currentTurnId && player.activeSourceCount > 0) {
        didReportPlaybackStart = true;
        ws.send(JSON.stringify({
          type: 'playback-started',
          at: performance.now(),
          turnId: currentTurnId
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
      if (message.type === 'prepare-turn') {
        currentTurnId = message.turnId;
        didReportPlaybackStart = false;
        if (!player.isActive) {
          await player.start();
        }
        return;
      }

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
          turnId: message.turnId
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
  fixtures: BrowserDuplexOverlapFixtureResult[],
): BrowserDuplexOverlapBenchmarkReport["summary"] => {
  const fixturePassCount = fixtures.filter((fixture) => fixture.passes).length;
  const turns = fixtures.flatMap((fixture) => fixture.turns);
  const firstAudioSamples = turns.filter(
    (turn) => typeof turn.firstAudioLatencyMs === "number",
  );
  const playbackSamples = turns.filter(
    (turn) => typeof turn.playbackStopLatencyMs === "number",
  );
  const sessionCloseSamples = turns.filter(
    (turn) => typeof turn.sessionCloseLatencyMs === "number",
  );
  const passedTurns = turns.filter((turn) => turn.pass).length;

  return {
    averageFirstAudioLatencyMs:
      firstAudioSamples.length > 0
        ? firstAudioSamples.reduce(
            (sum, turn) => sum + turn.firstAudioLatencyMs!,
            0,
          ) / firstAudioSamples.length
        : undefined,
    averagePlaybackStopLatencyMs:
      playbackSamples.length > 0
        ? playbackSamples.reduce(
            (sum, turn) => sum + turn.playbackStopLatencyMs!,
            0,
          ) / playbackSamples.length
        : undefined,
    averageSessionCloseLatencyMs:
      sessionCloseSamples.length > 0
        ? sessionCloseSamples.reduce(
            (sum, turn) => sum + turn.sessionCloseLatencyMs!,
            0,
          ) / sessionCloseSamples.length
        : undefined,
    fixturePassCount,
    fixturePassRate:
      fixtures.length > 0 ? fixturePassCount / fixtures.length : 0,
    totalTurns: turns.length,
    turnPassRate: turns.length > 0 ? passedTurns / turns.length : 0,
  };
};

const benchmarkAdapter = async (
  adapterId: string,
  adapter: TTSAdapter | RealtimeAdapter,
): Promise<BrowserDuplexOverlapFixtureResult> => {
  const errors: string[] = [];
  let browserSocket: Bun.ServerWebSocket<unknown> | null = null;
  const readyDeferred = createDeferred<void>();
  const playbackDeferredByTurn = new Map<string, Deferred<number>>();
  const interruptDeferredByTurn = new Map<
    string,
    Deferred<number | undefined>
  >();
  const turnStats = new Map<
    string,
    {
      audioChunkCount: number;
      firstAudioAt?: number;
      interruptRequestedAt?: number;
      playbackStopLatencyMs?: number;
      postInterruptAudioBytes: number;
      preInterruptAudioBytes: number;
      sessionClosedAt?: number;
      totalAudioBytes: number;
    }
  >();

  for (const turn of TURN_TEXTS) {
    playbackDeferredByTurn.set(turn.turnId, createDeferred<number>());
    interruptDeferredByTurn.set(
      turn.turnId,
      createDeferred<number | undefined>(),
    );
    turnStats.set(turn.turnId, {
      audioChunkCount: 0,
      postInterruptAudioBytes: 0,
      preInterruptAudioBytes: 0,
      totalAudioBytes: 0,
    });
  }

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
            playbackDeferredByTurn.get(message.turnId)?.resolve(message.at);
            return;
          }

          if (message.type === "interrupt-complete") {
            const stats = turnStats.get(message.turnId);
            if (stats) {
              stats.playbackStopLatencyMs = message.latencyMs;
            }
            interruptDeferredByTurn
              .get(message.turnId)
              ?.resolve(message.latencyMs);
            return;
          }

          if (message.type === "error") {
            errors.push(message.error);
            readyDeferred.reject(new Error(message.error));
            for (const deferred of playbackDeferredByTurn.values()) {
              deferred.reject(new Error(message.error));
            }
            for (const deferred of interruptDeferredByTurn.values()) {
              deferred.reject(new Error(message.error));
            }
          }
        } catch (error) {
          const nextError =
            error instanceof Error ? error.message : String(error);
          errors.push(nextError);
          readyDeferred.reject(error);
          for (const deferred of playbackDeferredByTurn.values()) {
            deferred.reject(error);
          }
          for (const deferred of interruptDeferredByTurn.values()) {
            deferred.reject(error);
          }
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

  try {
    await Promise.race([
      readyDeferred.promise,
      Bun.sleep(8_000).then(() => {
        throw new Error(
          `Browser harness did not become ready for ${adapterId}`,
        );
      }),
    ]);

    for (const turn of TURN_TEXTS) {
      let closed = false;
      const currentTurnId = turn.turnId;
      const stats = turnStats.get(currentTurnId)!;
      const session =
        adapter.kind === "realtime"
          ? await adapter.open({
              format: {
                channels: 1,
                container: "raw",
                encoding: "pcm_s16le",
                sampleRateHz: 24_000,
              },
              sessionId: `duplex-browser-overlap:${adapterId}:${currentTurnId}`,
            })
          : await adapter.open({
              sessionId: `duplex-browser-overlap:${adapterId}:${currentTurnId}`,
            });

      const unsubscribers = [
        session.on("audio", ({ chunk, format, receivedAt }) => {
          const normalized =
            chunk instanceof Uint8Array
              ? chunk
              : chunk instanceof ArrayBuffer
                ? new Uint8Array(chunk)
                : new Uint8Array(
                    chunk.buffer,
                    chunk.byteOffset,
                    chunk.byteLength,
                  );
          stats.audioChunkCount += 1;
          stats.totalAudioBytes += normalized.byteLength;
          if (stats.interruptRequestedAt !== undefined) {
            stats.postInterruptAudioBytes += normalized.byteLength;
          }
          stats.firstAudioAt ??= receivedAt;

          browserSocket?.send(
            JSON.stringify({
              type: "audio",
              chunkBase64: Buffer.from(normalized).toString("base64"),
              format,
              receivedAt,
              turnId: currentTurnId,
            }),
          );
        }),
        session.on("close", () => {
          closed = true;
          stats.sessionClosedAt = Date.now();
        }),
        session.on("error", (event) => {
          errors.push(event.error.message);
        }),
      ];

      browserSocket?.send(
        JSON.stringify({
          type: "prepare-turn",
          turnId: currentTurnId,
        }),
      );

      try {
        await session.send(turn.text);

        await Promise.race([
          playbackDeferredByTurn.get(currentTurnId)!.promise,
          Bun.sleep(8_000).then(() => {
            throw new Error(
              `Browser playback did not start in time for ${adapterId}:${currentTurnId}`,
            );
          }),
        ]);

        stats.preInterruptAudioBytes = stats.totalAudioBytes;
        stats.interruptRequestedAt = Date.now();
        browserSocket?.send(
          JSON.stringify({
            type: "interrupt",
            turnId: currentTurnId,
          }),
        );

        await Promise.race([
          interruptDeferredByTurn.get(currentTurnId)!.promise,
          Bun.sleep(4_000).then(() => {
            throw new Error(
              `Browser playback did not stop in time after barge-in for ${adapterId}:${currentTurnId}`,
            );
          }),
        ]);

        await session.close(
          `browser duplex overlap turn complete:${currentTurnId}`,
        );
        await waitFor(() => closed, 2_000);

        stats.postInterruptAudioBytes = Math.max(
          0,
          stats.totalAudioBytes - stats.preInterruptAudioBytes,
        );
      } finally {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }

        if (!closed) {
          await session.close(
            `browser duplex overlap cleanup:${currentTurnId}`,
          );
        }
      }
    }
  } finally {
    browserSocket?.send(JSON.stringify({ type: "shutdown" }));
    server.stop(true);
    chrome.kill();
    await chrome.exited.catch(() => undefined);
  }

  const turns = TURN_TEXTS.map((turn) => {
    const stats = turnStats.get(turn.turnId)!;
    const firstAudioLatencyMs =
      stats.firstAudioAt !== undefined
        ? stats.firstAudioAt - startedAt
        : undefined;
    const sessionCloseLatencyMs =
      stats.interruptRequestedAt !== undefined &&
      stats.sessionClosedAt !== undefined
        ? stats.sessionClosedAt - stats.interruptRequestedAt
        : undefined;
    const pass =
      stats.audioChunkCount > 0 &&
      stats.postInterruptAudioBytes === 0 &&
      typeof stats.playbackStopLatencyMs === "number";

    return {
      audioChunkCount: stats.audioChunkCount,
      firstAudioLatencyMs,
      pass,
      playbackStopLatencyMs: stats.playbackStopLatencyMs,
      postInterruptAudioBytes: stats.postInterruptAudioBytes,
      preInterruptAudioBytes: stats.preInterruptAudioBytes,
      sessionCloseLatencyMs,
      totalAudioBytes: stats.totalAudioBytes,
      turnId: turn.turnId,
    };
  });

  return {
    adapterId,
    errors,
    passes: errors.length === 0 && turns.every((turn) => turn.pass),
    turnPassRate:
      turns.length > 0
        ? turns.filter((turn) => turn.pass).length / turns.length
        : 0,
    turns,
  };
};

const env = await loadVoiceTestEnv();
const reports: BrowserDuplexOverlapBenchmarkReport[] = [];

await mkdir(resultsDir, { recursive: true });
await rm(resolveOutputPath(target), { force: true });

if (target === "all" || target === "elevenlabs") {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is required for browser duplex overlap benchmarks.",
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
      "OPENAI_API_KEY is required for browser duplex overlap benchmarks.",
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
    `Stale browser duplex overlap benchmark output detected: ${outputPath}`,
  );
}

console.log(`Saved browser duplex overlap benchmark JSON to ${outputPath}`);
