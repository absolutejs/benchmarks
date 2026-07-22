import { comparePairedMetrics, type VoiceSTTBenchmarkReport } from "@absolutejs/voice/testing";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) throw new Error("Usage: bun compare-stt-reports.ts <baseline.json> <candidate.json>");
const baseline = await Bun.file(baselinePath).json() as VoiceSTTBenchmarkReport;
const candidate = await Bun.file(candidatePath).json() as VoiceSTTBenchmarkReport;
const candidateById = new Map(candidate.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
const pairs = baseline.fixtures.map((fixture) => [fixture, candidateById.get(fixture.fixtureId)] as const).filter((pair) => pair[1]);
if (pairs.length !== baseline.fixtures.length || pairs.length !== candidate.fixtures.length) throw new Error("Reports must contain the same fixture ids for a paired comparison.");
console.log(JSON.stringify({
  baseline: baseline.adapterId, candidate: candidate.adapterId, fixtureCount: pairs.length,
  wordErrorRate: comparePairedMetrics(pairs.map(([fixture]) => fixture.accuracy.wordErrorRate), pairs.map(([, fixture]) => fixture!.accuracy.wordErrorRate)),
}, null, 2));
