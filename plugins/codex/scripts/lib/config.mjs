// Plan-007 Phase 2 + Phase 5 (config persistence for the Stop-hook gate).
// READ-ONLY for the user's ~/.codex/config.toml (we never write that file —
// see plan-007 round-2 RR5: TOML write + comment preservation is out of scope).
// The plugin's own workspace-scoped config (Stop-hook gate state) lives at
// <project>/.claudecode-buddy/codex/config.json — JSON, plugin-owned, writable.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Workspace-scoped plugin config (NOT the user's ~/.codex/config.toml).
// JSON format; plugin owns the schema:
//   {
//     "gate": { "enabled": boolean }
//   }
// Used by /codex:gate on/off/status and stop-review-gate-hook.mjs.

function configPath(projectDir) {
  return join(projectDir, ".claudecode-buddy", "codex", "config.json");
}

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

export function loadConfig(projectDir) {
  const path = configPath(projectDir);
  if (!existsSync(path)) {
    // No config yet — return default shape.
    return ok({ gate: { enabled: false } });
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return fail(`failed to read codex plugin config at ${path}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`failed to parse codex plugin config at ${path}: ${err.message}`);
  }
  // Normalize against schema.
  const gate = parsed.gate && typeof parsed.gate === "object"
    ? { enabled: parsed.gate.enabled === true }
    : { enabled: false };
  return ok({ gate });
}

export function updateConfig(projectDir, patch) {
  const current = loadConfig(projectDir);
  if (!current.ok) return current;
  const merged = {
    ...current.value,
    ...patch,
    gate: { ...current.value.gate, ...(patch.gate ?? {}) },
  };
  const path = configPath(projectDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    renameSync(tmp, path);
    return ok(merged);
  } catch (err) {
    return fail(`failed to write codex plugin config at ${path}: ${err.message}`);
  }
}
