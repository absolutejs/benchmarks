import { resolve } from "node:path";
import {
  evaluateVoiceSTTRouting,
  type VoiceSTTBenchmarkReport,
} from "@absolutejs/voice/testing";

const projectRoot = resolve(import.meta.dir, "..");
const primaryPath = resolve(process.argv[2] ?? "");
const fallbackPath = resolve(process.argv[3] ?? "");
const outputPath = resolve(
  process.argv[4] ??
    resolve(projectRoot, "benchmark-results", "stt-routing-evaluation.json"),
);
const confidenceThreshold = Number(
  process.env.STT_ROUTING_CONFIDENCE_THRESHOLD ?? "0.72",
);

if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    "Usage: bun run bench:stt:routing:evaluate <primary-report.json> <fallback-report.json> [output.json]",
  );
}

const readReport = async (path: string): Promise<VoiceSTTBenchmarkReport> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`STT benchmark report not found: ${path}`);
  }
  return file.json();
};

const [primary, fallback] = await Promise.all([
  readReport(primaryPath),
  readReport(fallbackPath),
]);
const fallbackByFixture = new Map(
  fallback.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
);

const scoreFixture = (fixture: VoiceSTTBenchmarkReport["fixtures"][number]) => {
  const wordAccuracy = Math.max(0, 1 - fixture.accuracy.wordErrorRate);
  const critical = fixture.criticalFields;
  return critical && critical.totalCount > 0
    ? wordAccuracy * 0.5 + critical.accuracy * 0.5
    : wordAccuracy;
};

const fixtures = primary.fixtures.flatMap((primaryFixture) => {
  const fallbackFixture = fallbackByFixture.get(primaryFixture.fixtureId);
  if (!fallbackFixture) return [];

  const triggers = [
    primaryFixture.finalText.trim().length === 0 ? "empty" : undefined,
    typeof primaryFixture.transcriptConfidence === "number" &&
    primaryFixture.transcriptConfidence < confidenceThreshold
      ? "low-confidence"
      : undefined,
    primaryFixture.criticalFields?.passesRequired === false
      ? "required-critical-field"
      : undefined,
  ].filter((value): value is string => value !== undefined);

  return [
    {
      fallbackScore: scoreFixture(fallbackFixture),
      fallbackUsed: triggers.length > 0,
      id: primaryFixture.fixtureId,
      primaryScore: scoreFixture(primaryFixture),
      triggers,
    },
  ];
});

const report = {
  confidenceThreshold,
  fallbackAdapterId: fallback.adapterId,
  fixtures,
  generatedAt: Date.now(),
  primaryAdapterId: primary.adapterId,
  summary: evaluateVoiceSTTRouting(fixtures),
};

await Bun.write(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Saved routing evaluation to ${outputPath}`);
