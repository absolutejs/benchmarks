import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildVoiceAudioMatrix, loadVoiceTestFixtures } from "@absolutejs/voice/testing";

const outputRoot = resolve(process.argv[2] ?? "voice/generated-fixtures/acoustic-matrix");
const fixtures = await loadVoiceTestFixtures({ includeBundled: true });
const matrix = buildVoiceAudioMatrix(fixtures, [
  { id: "gain-low", type: "gain", gain: 0.35 },
  { id: "clip-60", type: "clip", ceiling: 0.6 },
  { id: "snr-10", type: "noise", seed: 20_260_722, snrDb: 10 },
  { id: "loss-100ms-every-10", type: "drop-chunks", chunkDurationMs: 100, every: 10 },
]);
await mkdir(resolve(outputRoot, "pcm"), { recursive: true });
for (const fixture of matrix) await Bun.write(resolve(outputRoot, "pcm", `${fixture.id}.pcm`), fixture.audio);
await Bun.write(resolve(outputRoot, "manifest.json"), JSON.stringify(matrix.map(({ audio: _audio, ...fixture }) => ({ ...fixture, audioPath: `${fixture.id}.pcm` })), null, 2));
console.log(`Wrote ${matrix.length} deterministic conditioned fixtures to ${outputRoot}`);
