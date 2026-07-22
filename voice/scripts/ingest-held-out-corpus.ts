import { copyFile, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { sha256Bytes } from "@absolutejs/voice/testing";

const [metadataArgument, outputArgument] = process.argv.slice(2);
if (!metadataArgument || !outputArgument) throw new Error("Usage: bun ingest-held-out-corpus.ts <private-metadata.json> <private-output-dir>");
const metadataPath = resolve(metadataArgument);
const outputRoot = resolve(outputArgument);
const entries = await Bun.file(metadataPath).json() as Array<{ audioPath: string; consent: string; expectedText: string; id: string; title: string }>;
if (outputRoot.startsWith(resolve(import.meta.dir, ".."))) throw new Error("Private held-out output must be outside the public voice benchmark directory.");
await mkdir(resolve(outputRoot, "pcm"), { recursive: true });
const manifest = [];
for (const entry of entries) {
  if (!entry.consent?.trim()) throw new Error(`${entry.id}: consent metadata is required.`);
  const source = resolve(entry.audioPath);
  const fileName = `${entry.id}-${basename(source)}`;
  const audio = new Uint8Array(await Bun.file(source).arrayBuffer());
  await copyFile(source, resolve(outputRoot, "pcm", fileName));
  manifest.push({ ...entry, audioPath: fileName, provenance: { audioSha256: sha256Bytes(audio), consent: entry.consent, license: "private-evaluation-only", licenseClass: "private", source: "private-held-out", split: "private-held-out" } });
}
await Bun.write(resolve(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Ingested ${manifest.length} consented private fixtures outside the repository.`);
