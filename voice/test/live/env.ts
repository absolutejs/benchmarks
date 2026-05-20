import { resolve } from "node:path";

const ENV_PATH = resolve(import.meta.dir, "..", "..", ".env");

type VoiceTestEnv = {
  ASSEMBLYAI_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  OPENAI_API_KEY?: string;
};

let cachedEnv: VoiceTestEnv | null = null;

const parseEnv = (source: string): VoiceTestEnv => {
  const values: Record<string, string> = {};

  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    values[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return values as VoiceTestEnv;
};

const normalizeEnvValue = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "undefined" || normalized === "null") {
    return undefined;
  }

  return trimmed;
};

export const loadVoiceTestEnv = async () => {
  if (cachedEnv) {
    return cachedEnv;
  }

  const file = Bun.file(ENV_PATH);
  cachedEnv = (await file.exists()) ? parseEnv(await file.text()) : {};

  cachedEnv = Object.fromEntries(
    Object.entries(cachedEnv)
      .map(([key, value]) => [key, normalizeEnvValue(value)] as const)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
  ) as VoiceTestEnv;

  return cachedEnv;
};
