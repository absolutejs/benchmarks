import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

type FleursRow = {
  id: number;
  fileName: string;
  rawTranscription: string;
  transcription: string;
  numSamples: number;
  gender: string;
};

type BscRow = {
  audioId: string;
  duration: number;
  normalizedText: string;
  source: string;
  split: string;
};

type CoSHERow = {
  audioFileName: string;
  audioUrl: string;
  transcription: string;
};

type HuggingFaceRowsResponse<TRow> = {
  rows: Array<{
    row: TRow;
    row_idx: number;
  }>;
};

type CoSHEApiRow = {
  audio: Array<{
    src: string;
    type?: string;
  }>;
  audio_file_name: string;
  transcription: string;
};

type CorpusManifestEntry = {
  id: string;
  title: string;
  audioPath: string;
  expectedText: string;
  language: string;
  tags: string[];
  difficulty?: "clean" | "challenging";
};

type CorpusSourceEntry = {
  id: string;
  title: string;
  license: string;
  sourceUrl: string;
  split: string;
  language: string;
  audioArchiveUrl: string;
  metadataUrl: string;
};

const TARGET_ROOT = resolve("/home/alexkahn/abs/voice-fixtures-multilingual");
const PCM_DIR = join(TARGET_ROOT, "pcm");
const SOURCES_PATH = join(TARGET_ROOT, "sources.json");
const MANIFEST_PATH = join(TARGET_ROOT, "manifest.json");
const README_PATH = join(TARGET_ROOT, "README.md");

const FLEURS_LANGUAGES = [
  { code: "es_419", label: "Spanish (Latin America)", language: "es" },
  { code: "fr_fr", label: "French (France)", language: "fr" },
  { code: "de_de", label: "German (Germany)", language: "de" },
  { code: "hi_in", label: "Hindi (India)", language: "hi" },
  { code: "ar_eg", label: "Arabic (Egypt)", language: "ar" },
] as const;

const FLEURS_BASE =
  "https://huggingface.co/datasets/google/fleurs/resolve/main";
const BSC_BASE =
  "https://huggingface.co/datasets/BSC-LT/BSCs_Code_Switching_CA-ES_ASR_Test/resolve/main";
const COSHE_SOURCE_URL = "https://huggingface.co/datasets/soketlabs/CoSHE-Eval";
const COSHE_ROWS_URL =
  "https://datasets-server.huggingface.co/rows?dataset=soketlabs/CoSHE-Eval&config=default&split=eval&offset=0&length=80";
const FLEURS_LICENSE = "CC-BY-4.0";
const BSC_LICENSE = "CC-BY-NC-4.0";
const COSHE_LICENSE = "CC-BY-NC-4.0";

const FLEURS_PARALLEL_TARGET_COUNT = 3;
const CODE_SWITCH_TARGET_COUNT = 4;
const COSHE_TARGET_COUNT = 4;

const parser = new TextDecoder();

// Opportunistic HTTP/2 multiplexing for outbound HTTPS (Bun 1.3.14+).
// Corpus build fans out parallel downloads to a handful of dataset hosts
// (HuggingFace, etc.) — multiplexing eliminates per-fetch TLS handshake.
// The `protocol` option lands in @types/bun 1.3.14; widen locally for now.
// Hard-skip on non-HTTPS — Bun's h2 client throws HTTP2Unsupported on h2c.
type H2Init = RequestInit & { protocol?: "http2" };
const h2IfHttps = (url: string): H2Init =>
  url.startsWith("https://") ? { protocol: "http2" } : {};

const fetchText = async (url: string) => {
  const response = await fetch(url, h2IfHttps(url));
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return await response.text();
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, h2IfHttps(url));
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
};

const downloadFile = async (url: string, destination: string) => {
  await spawnOrThrow([
    "curl",
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "-o",
    destination,
    url,
  ]);
  return destination;
};

const ensureDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  return directory;
};

const parseFleursTsv = (input: string): FleursRow[] =>
  input
    .trim()
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 7)
    .map((columns) => ({
      fileName: columns[1]!,
      gender: columns[6]!,
      id: Number(columns[0]),
      numSamples: Number(columns[5]),
      rawTranscription: columns[2]!,
      transcription: columns[3]!,
    }));

const parseBscMetadata = (input: string): BscRow[] =>
  input
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 5)
    .map((columns) => ({
      audioId: columns[0]!,
      duration: Number(columns[3]),
      normalizedText: columns[4]!,
      source: columns[1]!,
      split: columns[2]!,
    }));

const toCorpusId = (parts: string[]) =>
  parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const pickFleursRows = (rows: FleursRow[], sentenceIds: number[]) => {
  const bySentenceId = new Map<number, FleursRow[]>();

  for (const row of rows) {
    const existing = bySentenceId.get(row.id) ?? [];
    existing.push(row);
    bySentenceId.set(row.id, existing);
  }

  return sentenceIds.map((id) => {
    const matches = bySentenceId.get(id);
    if (!matches || matches.length === 0) {
      throw new Error(`FLEURS sentence id ${id} not found in selected split.`);
    }

    return matches.sort(
      (left, right) => left.numSamples - right.numSamples,
    )[0]!;
  });
};

const selectParallelSentenceIds = (
  rowsByLanguage: Map<string, FleursRow[]>,
) => {
  const languages = Array.from(rowsByLanguage.keys());
  const primaryRows = rowsByLanguage.get(FLEURS_LANGUAGES[0].code);
  if (!primaryRows) {
    throw new Error("Primary FLEURS language rows were not loaded.");
  }

  const commonIds = languages.reduce<Set<number> | null>((acc, language) => {
    const rows = rowsByLanguage.get(language) ?? [];
    const ids = new Set(rows.map((row) => row.id));
    if (!acc) {
      return ids;
    }

    return new Set(Array.from(acc).filter((id) => ids.has(id)));
  }, null);

  if (!commonIds || commonIds.size === 0) {
    throw new Error(
      "No common FLEURS sentence ids were found across the selected languages.",
    );
  }

  const selected: number[] = [];
  for (const row of primaryRows) {
    if (!commonIds.has(row.id)) {
      continue;
    }

    if (row.numSamples < 70_000 || row.numSamples > 220_000) {
      continue;
    }

    if (!selected.includes(row.id)) {
      selected.push(row.id);
    }

    if (selected.length >= FLEURS_PARALLEL_TARGET_COUNT) {
      break;
    }
  }

  if (selected.length < FLEURS_PARALLEL_TARGET_COUNT) {
    throw new Error(
      `Unable to select ${FLEURS_PARALLEL_TARGET_COUNT} parallel FLEURS sentence ids from the chosen languages.`,
    );
  }

  return selected;
};

const pickBscRows = (rows: BscRow[]) => {
  const bySource = new Map<string, BscRow[]>();

  for (const row of rows) {
    if (row.split !== "test") {
      continue;
    }

    const existing = bySource.get(row.source) ?? [];
    existing.push(row);
    bySource.set(row.source, existing);
  }

  const selected: BscRow[] = [];
  for (const [source, sourceRows] of bySource) {
    const sourceSelection = sourceRows
      .filter((row) => row.duration >= 5 && row.duration <= 15)
      .slice(0, 2);

    if (sourceSelection.length === 0) {
      throw new Error(`No suitable BSC rows found for source ${source}.`);
    }

    selected.push(...sourceSelection);
  }

  return selected.slice(0, CODE_SWITCH_TARGET_COUNT);
};

const hasLatinScript = (value: string) => /\p{Script=Latin}/u.test(value);
const hasDevanagariScript = (value: string) =>
  /\p{Script=Devanagari}/u.test(value);

const fetchCoSHERows = async (): Promise<CoSHERow[]> => {
  const response =
    await fetchJson<HuggingFaceRowsResponse<CoSHEApiRow>>(COSHE_ROWS_URL);

  return response.rows
    .map(({ row }) => ({
      audioFileName: row.audio_file_name,
      audioUrl: row.audio[0]?.src ?? "",
      transcription: row.transcription,
    }))
    .filter(
      (row): row is CoSHERow =>
        row.audioUrl.trim().length > 0 && row.transcription.trim().length > 0,
    );
};

const pickCoSHERows = (rows: CoSHERow[]) => {
  const selected = rows.filter((row) => {
    const transcription = row.transcription.trim();
    if (transcription.length < 80 || transcription.length > 1_200) {
      return false;
    }

    return hasLatinScript(transcription) && hasDevanagariScript(transcription);
  });

  if (selected.length < COSHE_TARGET_COUNT) {
    throw new Error(
      `Unable to select ${COSHE_TARGET_COUNT} mixed-script CoSHE rows from the public eval split.`,
    );
  }

  return selected.slice(0, COSHE_TARGET_COUNT);
};

const spawnOrThrow = async (command: string[], cwd?: string) => {
  const proc = Bun.spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return;
  }

  const stderr = parser.decode(await new Response(proc.stderr).arrayBuffer());
  throw new Error(
    `Command failed (${command.join(" ")}): ${stderr.trim() || `exit ${exitCode}`}`,
  );
};

const findFileByBasename = async (
  root: string,
  targetBasename: string,
): Promise<string | undefined> => {
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileByBasename(fullPath, targetBasename);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (entry.name === targetBasename) {
      return fullPath;
    }
  }

  return undefined;
};

const extractArchiveMembers = async (
  archivePath: string,
  memberPatterns: string[],
  outputDirectory: string,
) => {
  await ensureDirectory(outputDirectory);
  await spawnOrThrow([
    "tar",
    "-xzf",
    archivePath,
    "-C",
    outputDirectory,
    "--wildcards",
    "--no-anchored",
    ...memberPatterns,
  ]);
};

const convertToPcm16 = async (inputPath: string, outputPath: string) => {
  await spawnOrThrow([
    "ffmpeg",
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    outputPath,
  ]);
};

const buildReadme = (
  manifest: CorpusManifestEntry[],
  sources: CorpusSourceEntry[],
) => `# Multilingual Voice Benchmark Corpus

Generated by \`voice/scripts/build-multilingual-corpus.ts\`.

Contents:

- ${manifest.length} PCM fixtures
- ${sources.length} source descriptors
- sources: FLEURS dev split, BSC Catalan-Spanish code-switch test set, and CoSHE Hindi-English code-switch eval set

Licenses:

- FLEURS: ${FLEURS_LICENSE}
- BSC Code-Switching CA-ES ASR Test: ${BSC_LICENSE}
- CoSHE-Eval: ${COSHE_LICENSE}

This corpus is intended for local benchmarking with:

\`\`\`bash
VOICE_FIXTURE_DIR=${TARGET_ROOT} bun run bench:multilingual
\`\`\`
`;

const resolveBscMetadataSourceFromArchive = (archiveBaseName: string) => {
  if (archiveBaseName === "parlament_parla") {
    return "parlament_parla_v3";
  }

  return archiveBaseName;
};

const buildFleursFixtures = async (
  tempRoot: string,
): Promise<{
  manifest: CorpusManifestEntry[];
  sources: CorpusSourceEntry[];
}> => {
  const manifest: CorpusManifestEntry[] = [];
  const sources: CorpusSourceEntry[] = [];
  const rowsByLanguage = new Map<string, FleursRow[]>();

  for (const language of FLEURS_LANGUAGES) {
    const metadataUrl = `${FLEURS_BASE}/data/${language.code}/dev.tsv`;
    console.log(`Fetching FLEURS metadata: ${language.code}`);
    rowsByLanguage.set(
      language.code,
      parseFleursTsv(await fetchText(metadataUrl)),
    );
  }

  const selectedSentenceIds = selectParallelSentenceIds(rowsByLanguage);
  console.log(
    `Selected FLEURS sentence ids: ${selectedSentenceIds.join(", ")}`,
  );

  for (const language of FLEURS_LANGUAGES) {
    const metadataUrl = `${FLEURS_BASE}/data/${language.code}/dev.tsv`;
    const archiveUrl = `${FLEURS_BASE}/data/${language.code}/audio/dev.tar.gz`;
    const rows = pickFleursRows(
      rowsByLanguage.get(language.code) ?? [],
      selectedSentenceIds,
    );
    const archivePath = join(tempRoot, `${language.code}-dev.tar.gz`);
    const extractRoot = join(tempRoot, `extract-${language.code}`);

    console.log(`Downloading FLEURS archive: ${language.code}`);
    await downloadFile(archiveUrl, archivePath);
    console.log(`Extracting FLEURS archive: ${language.code}`);
    await extractArchiveMembers(
      archivePath,
      rows.map((row) => row.fileName),
      extractRoot,
    );

    for (const row of rows) {
      const extracted = await findFileByBasename(extractRoot, row.fileName);
      if (!extracted) {
        throw new Error(
          `Unable to locate extracted FLEURS audio ${row.fileName} for ${language.code}.`,
        );
      }

      const corpusId = toCorpusId(["fleurs", language.code, String(row.id)]);
      const pcmFileName = `${corpusId}.pcm`;
      console.log(`Converting FLEURS fixture: ${corpusId}`);
      await convertToPcm16(extracted, join(PCM_DIR, pcmFileName));

      manifest.push({
        audioPath: pcmFileName,
        difficulty: "clean",
        expectedText: row.rawTranscription,
        id: corpusId,
        language: language.language,
        tags: ["benchmark", "fleurs", "multilingual", language.code],
        title: `FLEURS ${language.label} sentence ${row.id}`,
      });

      sources.push({
        audioArchiveUrl: archiveUrl,
        id: corpusId,
        language: language.language,
        license: FLEURS_LICENSE,
        metadataUrl,
        sourceUrl: "https://huggingface.co/datasets/google/fleurs",
        split: "dev",
        title: `FLEURS ${language.label} sentence ${row.id}`,
      });
    }

    await rm(archivePath, { force: true });
    await rm(extractRoot, { force: true, recursive: true });
  }

  return { manifest, sources };
};

const buildBscFixtures = async (
  tempRoot: string,
): Promise<{
  manifest: CorpusManifestEntry[];
  sources: CorpusSourceEntry[];
}> => {
  const metadataUrl = `${BSC_BASE}/corpus/files/metadata.tsv`;
  const tarsPathsUrl = `${BSC_BASE}/corpus/files/tars.paths`;
  const metadata = parseBscMetadata(await fetchText(metadataUrl));
  const tarPaths = (await fetchText(tarsPathsUrl))
    .trim()
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry): entry is string => entry.length > 0);
  const selectedRows = pickBscRows(metadata);
  const selectedBySource = new Map<string, string[]>();
  const manifest: CorpusManifestEntry[] = [];
  const sources: CorpusSourceEntry[] = [];

  for (const row of selectedRows) {
    const existing = selectedBySource.get(row.source) ?? [];
    existing.push(`${row.audioId}.*`);
    selectedBySource.set(row.source, existing);
  }

  for (const tarPath of tarPaths) {
    const sourceName = basename(tarPath, ".tar.gz");
    const metadataSourceName = resolveBscMetadataSourceFromArchive(sourceName);
    const patterns = selectedBySource.get(metadataSourceName);
    if (!patterns || patterns.length === 0) {
      continue;
    }

    const archiveUrl = `${BSC_BASE}/${tarPath}`;
    const archivePath = join(tempRoot, `${sourceName}.tar.gz`);
    const extractRoot = join(tempRoot, `extract-${sourceName}`);

    console.log(`Downloading BSC archive: ${sourceName}`);
    await downloadFile(archiveUrl, archivePath);
    console.log(`Extracting BSC archive: ${sourceName}`);
    await extractArchiveMembers(archivePath, patterns, extractRoot);

    for (const row of selectedRows.filter(
      (entry) => entry.source === metadataSourceName,
    )) {
      const extracted =
        (await findFileByBasename(extractRoot, `${row.audioId}.wav`)) ??
        (await findFileByBasename(extractRoot, `${row.audioId}.mp3`)) ??
        (await findFileByBasename(extractRoot, `${row.audioId}.flac`));

      if (!extracted) {
        throw new Error(
          `Unable to locate extracted BSC audio ${row.audioId} for source ${sourceName}.`,
        );
      }

      const corpusId = toCorpusId(["bsc", "ca-es", row.audioId]);
      const pcmFileName = `${corpusId}.pcm`;
      console.log(`Converting BSC fixture: ${corpusId}`);
      await convertToPcm16(extracted, join(PCM_DIR, pcmFileName));

      const title = `BSC CA-ES code-switch ${row.audioId}`;

      manifest.push({
        audioPath: pcmFileName,
        difficulty: "challenging",
        expectedText: row.normalizedText,
        id: corpusId,
        language: "ca-es",
        tags: ["benchmark", "multilingual", "code-switch", "ca-es", sourceName],
        title,
      });

      sources.push({
        audioArchiveUrl: archiveUrl,
        id: corpusId,
        language: "ca-es",
        license: BSC_LICENSE,
        metadataUrl,
        sourceUrl:
          "https://huggingface.co/datasets/BSC-LT/BSCs_Code_Switching_CA-ES_ASR_Test",
        split: row.split,
        title,
      });
    }

    await rm(archivePath, { force: true });
    await rm(extractRoot, { force: true, recursive: true });
  }

  return { manifest, sources };
};

const buildCoSHEFixtures = async (
  tempRoot: string,
): Promise<{
  manifest: CorpusManifestEntry[];
  sources: CorpusSourceEntry[];
}> => {
  const rows = pickCoSHERows(await fetchCoSHERows());
  const manifest: CorpusManifestEntry[] = [];
  const sources: CorpusSourceEntry[] = [];

  for (const row of rows) {
    const tempAudioPath = join(tempRoot, row.audioFileName);
    const fileStem = basename(row.audioFileName).replace(/\.[^.]+$/u, "");
    const corpusId = toCorpusId(["coshe", "hi-en", fileStem]);
    const pcmFileName = `${corpusId}.pcm`;
    const title = `CoSHE HI-EN code-switch ${fileStem}`;

    console.log(`Downloading CoSHE fixture: ${row.audioFileName}`);
    await downloadFile(row.audioUrl, tempAudioPath);
    console.log(`Converting CoSHE fixture: ${corpusId}`);
    await convertToPcm16(tempAudioPath, join(PCM_DIR, pcmFileName));

    manifest.push({
      audioPath: pcmFileName,
      difficulty: "challenging",
      expectedText: row.transcription,
      id: corpusId,
      language: "hi-en",
      tags: ["benchmark", "multilingual", "code-switch", "hi-en", "coshe-eval"],
      title,
    });

    sources.push({
      audioArchiveUrl: row.audioUrl,
      id: corpusId,
      language: "hi-en",
      license: COSHE_LICENSE,
      metadataUrl: COSHE_ROWS_URL,
      sourceUrl: COSHE_SOURCE_URL,
      split: "eval",
      title,
    });

    await rm(tempAudioPath, { force: true });
  }

  return { manifest, sources };
};

const main = async () => {
  await rm(TARGET_ROOT, { force: true, recursive: true });
  await ensureDirectory(PCM_DIR);

  const tempRoot = await mkdtemp(join(tmpdir(), "voice-multilingual-corpus-"));

  try {
    const fleurs = await buildFleursFixtures(tempRoot);
    const bsc = await buildBscFixtures(tempRoot);
    const coshe = await buildCoSHEFixtures(tempRoot);
    const manifest = [...fleurs.manifest, ...bsc.manifest, ...coshe.manifest];
    const sources = [...fleurs.sources, ...bsc.sources, ...coshe.sources];

    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, "\t"));
    await writeFile(SOURCES_PATH, JSON.stringify(sources, null, "\t"));
    await writeFile(README_PATH, buildReadme(manifest, sources));

    console.log(
      JSON.stringify(
        {
          fixtureCount: manifest.length,
          outputDirectory: TARGET_ROOT,
          sourceCount: sources.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

await main();
