import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  aggregateTranscriptAccuracy,
  buildVoiceBenchmarkArtifact,
  sha256Bytes,
  summarizeVoiceBenchmarkOutcomes,
  type VoiceBenchmarkPromptTrack,
  type VoiceSTTBenchmarkReport,
} from "@absolutejs/voice/testing";

const reportArgument = process.argv[2];
if (!reportArgument) throw new Error("Usage: bun build-stt-artifact.ts <report.json> [--track production-context]");
const trackIndex = process.argv.indexOf("--track");
const promptTrack = (process.argv[trackIndex + 1] ?? "production-context") as VoiceBenchmarkPromptTrack;
if (!["unprompted", "production-context", "oracle-seeded"].includes(promptTrack)) throw new Error(`Invalid prompt track: ${promptTrack}`);
const voiceRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(voiceRoot, "..");
const fixtureRoot = resolve(voiceRoot, "fixtures");
const reportPath = resolve(process.cwd(), reportArgument);
const report = await Bun.file(reportPath).json() as VoiceSTTBenchmarkReport;
const fixtureManifest = await Bun.file(resolve(fixtureRoot, "manifest.json")).json() as Array<{ audioPath: string; id: string }>;
const datasheet = await Bun.file(resolve(fixtureRoot, "datasheet.json")).json() as { name: string; version: string };
const includedFixtureIds = new Set(report.fixtures.map((fixture) => fixture.fixtureId));
const fixtures = await Promise.all(fixtureManifest.filter((fixture) => includedFixtureIds.has(fixture.id)).map(async (fixture) => {
  const audio = new Uint8Array(await Bun.file(resolve(fixtureRoot, "pcm", fixture.audioPath)).arrayBuffer());
  const noncommercial = fixture.id.startsWith("stella-");
  return {
    audioSha256: sha256Bytes(audio), fixtureId: fixture.id,
    license: noncommercial ? "CC BY-NC-SA 2.0" : "CC BY 4.0",
    licenseClass: noncommercial ? "noncommercial" as const : "permissive" as const,
    source: noncommercial ? "Speech Accent Archive" : "LibriSpeech-derived",
    split: "public-test" as const,
  };
}));
const git = (args: string[]) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const enrichedReport = {
  ...report,
  errorMetrics: aggregateTranscriptAccuracy(report.fixtures.map((fixture) => fixture.accuracy)),
  outcomes: summarizeVoiceBenchmarkOutcomes(report.fixtures),
};
const artifact = buildVoiceBenchmarkArtifact({
  adapter: { id: report.adapterId },
  corpus: { fixtures, manifestSha256: sha256Bytes(await Bun.file(resolve(fixtureRoot, "manifest.json")).text()), name: datasheet.name, version: datasheet.version },
  createdAt: new Date().toISOString(),
  environment: { arch: process.arch, bun: Bun.version, platform: process.platform },
  git: { branch: git(["branch", "--show-current"]), commit: git(["rev-parse", "HEAD"]) },
  preprocessing: { audio: "manifest-defined PCM", normalization: "@absolutejs/voice/testing default" },
  promptTrack, seed: 20_260_722,
}, enrichedReport);
const outputDirectory = resolve(voiceRoot, "benchmark-artifacts");
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, `${basename(reportPath, ".json")}-${artifact.artifactSha256.slice(0, 12)}.json`);
await Bun.write(outputPath, JSON.stringify(artifact, null, 2));
console.log(outputPath);
