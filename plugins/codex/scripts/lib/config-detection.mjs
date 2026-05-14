import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Codex config path. Honors CODEX_HOME env override (codex's own convention)
// before falling back to ~/.codex/. Different from opencode which uses
// OPENCODE_CONFIG to override the file path directly.
export function defaultConfigPath() {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

// Minimal TOML reader: codex config has a flat top-level `model = "..."`
// and `model_reasoning_effort = "..."`. We only need those two keys. A
// full TOML parser would be overkill (workspace is currently dep-free).
// The regex matches `key = "value"` on a single line, ignoring comments
// (# ...) and quoted-string values. Multiline strings, arrays, and
// non-trivial TOML constructs are out of scope.
function readTopLevelTomlString(raw, key) {
  // Stop at the first table header (lines starting with `[`) so we don't
  // pick up keys nested under [section.subsection].
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break; // entered a table; top-level done
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    const m = trimmed.match(/^([a-z_][a-z0-9_]*)\s*=\s*"([^"]*)"\s*(?:#.*)?$/i);
    if (m && m[1] === key) return m[2];
  }
  return null;
}

export function detectConfig({ configPath = defaultConfigPath() } = {}) {
  if (!existsSync(configPath)) {
    return { ok: false, error: `config not found at ${configPath} — run \`codex\` once to initialize it, or set a default model via \`codex\`'s own config flow` };
  }
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    return { ok: false, error: `failed to read config at ${configPath}: ${err.message}` };
  }
  const model = readTopLevelTomlString(raw, "model");
  if (!model || model.length === 0) {
    return { ok: false, error: `no top-level \`model\` field in ${configPath} — set one (e.g., \`model = "gpt-5"\`)` };
  }
  return { ok: true, model, configPath };
}
