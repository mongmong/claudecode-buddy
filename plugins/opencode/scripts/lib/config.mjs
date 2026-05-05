import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  stopReviewGate: false,
});

export function configPath(projectDir) {
  return join(projectDir, ".claudecode-buddy", "opencode", "config.json");
}

export function loadConfig(projectDir) {
  const path = configPath(projectDir);
  if (!existsSync(path)) return { ok: true, value: { ...DEFAULT_CONFIG } };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
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
  return { ok: true, value: { ...DEFAULT_CONFIG, ...parsed } };
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
