import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigPath() {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

export function detectConfig({ configPath = defaultConfigPath() } = {}) {
  if (!existsSync(configPath)) {
    return { ok: false, error: `config not found at ${configPath} — set a default model with \`opencode\` and configure your provider` };
  }
  let raw, parsed;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    return { ok: false, error: `failed to read config at ${configPath}: ${err.message}` };
  }
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `failed to parse config JSON at ${configPath}: ${err.message}` };
  }
  if (typeof parsed.model !== "string" || parsed.model.length === 0) {
    return { ok: false, error: `no default \`model\` field in ${configPath} — set one (e.g., "model": "anthropic/claude-sonnet-4-6")` };
  }
  return { ok: true, model: parsed.model, configPath };
}
