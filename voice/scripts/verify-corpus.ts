import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Bytes } from "@absolutejs/voice/testing";

const root = resolve(import.meta.dir, "..", "fixtures");
const checksumLines = (await readFile(resolve(root, "checksums.sha256"), "utf8"))
  .trim().split("\n").filter(Boolean);
const manifest = await Bun.file(resolve(root, "manifest.json")).json() as Array<{ audioPath: string; id: string }>;
const failures: string[] = [];
const expected = new Map(checksumLines.map((line) => {
  const [hash, path] = line.trim().split(/\s+/, 2);
  return [path!, hash!];
}));
for (const fixture of manifest) {
  const path = `pcm/${fixture.audioPath}`;
  const file = Bun.file(resolve(root, path));
  if (!(await file.exists())) failures.push(`${fixture.id}: missing ${path}`);
  else if (sha256Bytes(new Uint8Array(await file.arrayBuffer())) !== expected.get(path))
    failures.push(`${fixture.id}: checksum mismatch for ${path}`);
}
if (expected.size !== manifest.length) failures.push(`checksum count ${expected.size} does not match manifest count ${manifest.length}`);
if (failures.length) throw new Error(`Corpus verification failed:\n${failures.join("\n")}`);
console.log(`Verified ${manifest.length} fixtures and checksums.`);
