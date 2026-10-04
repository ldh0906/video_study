import path from "node:path";
import { DATA_DIR, readJson, writeJson } from "./paths";
import type { Provider, PublicSettings, Settings } from "../shared/types";

const FILE = path.join(DATA_DIR, "settings.json");

const DEFAULTS: Settings = {
  openaiApiKey: "",
  anthropicApiKey: "",
  connection: { openai: "cli", anthropic: "cli" },
  whisperModel: "large-v3-turbo-q5_0",
  analysis: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  chat: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" },
  transcription: "local-whisper",
  outputLanguage: "ko",
  spokenLanguage: "",
  subtitlePolicy: "prefer",
  visualAnalysis: true,
  framesPerSection: 6,
  concurrency: 3,
  downloadQuality: "720",
  cookiesFromBrowser: "",
};

export function getSettings(): Settings {
  const stored = readJson<Partial<Settings>>(FILE, {});
  return { ...DEFAULTS, ...stored, connection: { ...DEFAULTS.connection, ...stored.connection } };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  writeJson(FILE, next);
  return next;
}

export function apiKey(provider: Provider, s: Settings = getSettings()): string {
  if (provider === "openai") return s.openaiApiKey || process.env.OPENAI_API_KEY || "";
  return s.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
}

function keyInfo(stored: string, env: string | undefined) {
  const key = stored || env || "";
  return {
    set: Boolean(key),
    source: stored ? ("settings" as const) : env ? ("env" as const) : null,
    hint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : "",
  };
}

export function publicSettings(): PublicSettings {
  const { openaiApiKey, anthropicApiKey, ...rest } = getSettings();
  return {
    ...rest,
    keys: {
      openai: keyInfo(openaiApiKey, process.env.OPENAI_API_KEY),
      anthropic: keyInfo(anthropicApiKey, process.env.ANTHROPIC_API_KEY),
    },
  };
}
