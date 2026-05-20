import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { elevenlabs } from "@absolutejs/voice-elevenlabs";
import { openai } from "@absolutejs/voice-openai";
import {
  getDefaultTTSBenchmarkFixtures,
  runTTSAdapterBenchmark,
  type VoiceTTSBenchmarkReport,
} from "@absolutejs/voice/testing";

const projectRoot = resolve(import.meta.dir, "..");
const resultsDir = resolve(projectRoot, "benchmark-results");

const resolveOutputPath = (target: string, profile: string) =>
  resolve(
    resultsDir,
    profile === "default"
      ? `tts-${target}.json`
      : `tts-${target}-${profile}.json`,
  );

const target = (process.argv[2] ?? "all").trim().toLowerCase();
const profile = (process.argv[3] ?? "default").trim().toLowerCase();
const supportedTargets = new Set(["all", "elevenlabs", "openai"]);
const supportedProfiles = new Set(["default", "interrupt"]);

if (!supportedTargets.has(target)) {
  throw new Error(
    `Unsupported TTS benchmark target "${target}". Use one of: ${[
      ...supportedTargets,
    ].join(", ")}`,
  );
}

if (!supportedProfiles.has(profile)) {
  throw new Error(
    `Unsupported TTS benchmark profile "${profile}". Use one of: ${[
      ...supportedProfiles,
    ].join(", ")}`,
  );
}

const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
const elevenlabsVoiceId =
  process.env.ELEVENLABS_VOICE_ID?.trim() || "JBFqnCBsd6RMkjVDRZzb";
const openaiApiKey = process.env.OPENAI_API_KEY?.trim();

const fixtures = getDefaultTTSBenchmarkFixtures();
const startedAt = Date.now();

await mkdir(resultsDir, { recursive: true });
await rm(resolveOutputPath(target, profile), { force: true });

const reports: VoiceTTSBenchmarkReport[] = [];

if (target === "all" || target === "elevenlabs") {
  if (!elevenlabsApiKey) {
    throw new Error("ELEVENLABS_API_KEY is required for TTS benchmarks.");
  }

  reports.push(
    await runTTSAdapterBenchmark(
      "elevenlabs",
      elevenlabs({
        apiKey: elevenlabsApiKey,
        modelId: "eleven_flash_v2_5",
        outputFormat: "pcm_16000",
        voiceId: elevenlabsVoiceId,
      }),
      fixtures,
      profile === "interrupt"
        ? {
            interruptAfterFirstAudioMs: 150,
            minAudioBytes: 256,
            waitForCloseAfterInterruptMs: 4_000,
          }
        : undefined,
    ),
  );
}

if (target === "all" || target === "openai") {
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for TTS benchmarks.");
  }

  reports.push(
    await runTTSAdapterBenchmark(
      "openai",
      openai({
        apiKey: openaiApiKey,
        model: "gpt-realtime-mini",
        responseMode: "audio",
        voice: "marin",
      }),
      fixtures,
      profile === "interrupt"
        ? {
            interruptAfterFirstAudioMs: 150,
            minAudioBytes: 256,
            waitForCloseAfterInterruptMs: 4_000,
          }
        : undefined,
    ),
  );
}

const output =
  target === "all"
    ? {
        generatedAt: Date.now(),
        profileId: profile,
        reports,
      }
    : reports[0];

const outputPath = resolveOutputPath(target, profile);
await Bun.write(outputPath, JSON.stringify(output, null, 2));

const metadata = await stat(outputPath);
if (metadata.mtimeMs < startedAt) {
  throw new Error(`Stale TTS benchmark output detected: ${outputPath}`);
}

console.log(`Saved TTS benchmark JSON to ${outputPath}`);
