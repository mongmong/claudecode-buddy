import { readFileSync, existsSync } from "node:fs";

// Codex config is TOML, not JSON. Unlike opencode's config which enumerates
// provider.<name>.models.<id> trees, codex's config has only a top-level
// `model = "..."` setting (and optionally `model_reasoning_effort`). There's
// no in-config catalog of available models — codex routes the requested
// model name to its provider directly.
//
// For the model picker, we return:
//   1. The default `model` from the user's config.toml (if set).
//   2. A small hardcoded list of commonly-recognized codex models as
//      additional options the user can pick from. The picker UI's
//      `Other (specify model id)` option covers anything outside this list.
//
// The hardcoded list is intentionally minimal — codex's model namespace is
// curated by OpenAI; users typically pick gpt-5 family or o-series. Add to
// this list when a new well-known model lands.
const WELL_KNOWN_CODEX_MODELS = Object.freeze([
  "gpt-5",
  "gpt-5.5",
  "o3",
  "o4",
]);

// Reuse the same minimal TOML reader as config-detection.mjs.
function readTopLevelTomlString(raw, key) {
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    const m = trimmed.match(/^([a-z_][a-z0-9_]*)\s*=\s*"([^"]*)"\s*(?:#.*)?$/i);
    if (m && m[1] === key) return m[2];
  }
  return null;
}

export function listModels({ configPath }) {
  if (!existsSync(configPath)) {
    return { ok: false, error: `config not found at ${configPath}` };
  }
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    return { ok: false, error: `failed to read ${configPath}: ${err.message}` };
  }
  const defaultModel = readTopLevelTomlString(raw, "model");
  const found = new Set();
  if (defaultModel && defaultModel.length > 0) found.add(defaultModel);
  for (const m of WELL_KNOWN_CODEX_MODELS) found.add(m);

  if (found.size === 0) {
    return {
      ok: false,
      error:
        `no models found in ${configPath} and no well-known fallback list. ` +
        `Set a default \`model = "..."\` field.`,
    };
  }

  const all = [...found];
  const def = defaultModel && defaultModel.length > 0 ? defaultModel : null;
  const rest = all.filter((m) => m !== def).sort();
  return { ok: true, value: def ? [def, ...rest] : rest };
}
