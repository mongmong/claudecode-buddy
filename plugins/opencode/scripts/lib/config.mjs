import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  stopReviewGate: false,
});

// Per-key validators. A value passes the validator → user value wins. Fails
// → fall back to DEFAULT_CONFIG[key] with a stderr warning. Catches subtle
// bugs like manual JSON edits writing strings instead of booleans
// (`"stopReviewGate":"false"` would otherwise be truthy and enable the gate).
const VALIDATORS = {
  stopReviewGate: (v) => typeof v === "boolean",
};

export function configPath(projectDir) {
  return join(projectDir, ".claudecode-buddy", "opencode", "config.json");
}

export function loadConfig(projectDir) {
  const path = configPath(projectDir);
  // Open + read in a single try; ENOENT → defaults (no TOCTOU window between
  // existsSync and readFileSync). Other errors propagate as ok:false.
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, value: { ...DEFAULT_CONFIG } };
    return { ok: false, error: `failed to read ${path}: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`warn: ${path} is not valid JSON (${err.message}); using defaults\n`);
    return { ok: true, value: { ...DEFAULT_CONFIG } };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(`warn: ${path} is not a JSON object; using defaults\n`);
    return { ok: true, value: { ...DEFAULT_CONFIG } };
  }
  // Per-key validation: drop user values that fail the validator (warn).
  const validated = {};
  for (const [k, v] of Object.entries(parsed)) {
    const validator = VALIDATORS[k];
    if (validator && !validator(v)) {
      process.stderr.write(
        `warn: ${path} has invalid type for "${k}" (got ${typeof v}); using default ${JSON.stringify(DEFAULT_CONFIG[k])}\n`,
      );
      continue;
    }
    validated[k] = v;
  }
  return { ok: true, value: { ...DEFAULT_CONFIG, ...validated } };
}

export function updateConfig(projectDir, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "patch must be a JSON object" };
  }
  const current = loadConfig(projectDir);
  if (!current.ok) return current;
  const next = { ...current.value, ...patch };
  const path = configPath(projectDir);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, path);
    return { ok: true, value: next };
  } catch (err) {
    return { ok: false, error: `failed to write ${path}: ${err.message}` };
  }
}
