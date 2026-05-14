import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Well-known install locations for codex binary. Scanned in order; first
// existing + executable hit wins. ~/.codex/bin is the official installer's
// drop point (where `codex update` and the initial install put it).
const WELL_KNOWN_PATHS = [
  "~/.codex/bin/codex",
  "~/.local/bin/codex",
  "~/.bun/bin/codex",
  "~/.npm-global/bin/codex",
  "~/.npm/bin/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "/usr/bin/codex",
];

function expandHome(p, home) {
  if (!p.startsWith("~/")) return p;
  if (!home) return null;
  return join(home, p.slice(2));
}

function isExecutableFile(path) {
  if (!existsSync(path)) return false;
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function scanWellKnownPaths(env) {
  for (const entry of WELL_KNOWN_PATHS) {
    const expanded = expandHome(entry, env.HOME);
    if (!expanded) continue;
    if (isExecutableFile(expanded)) return expanded;
  }
  return null;
}

function pathHasCodex(env) {
  try {
    execFileSync("codex", ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function resolveBinary(env) {
  if (env.CODEX_BIN) {
    if (existsSync(env.CODEX_BIN)) return env.CODEX_BIN;
    return null;
  }
  if (pathHasCodex(env)) return "codex";
  const fromScan = scanWellKnownPaths(env);
  if (fromScan) return fromScan;
  return null;
}

function buildGuidance(env) {
  const expanded = WELL_KNOWN_PATHS
    .map((p) => expandHome(p, env.HOME))
    .filter(Boolean);
  return `codex is not installed or not reachable.

Install: visit https://github.com/openai/codex or run \`npm install -g @openai/codex\` (depends on your distribution).
Then verify: \`codex --version\`

Looked for the binary in:
  - \`codex\` on PATH
${expanded.map((p) => `  - ${p}`).join("\n")}

If codex is installed at a non-standard path, set CODEX_BIN to the absolute binary path.`;
}

export function detectCodex({ env = process.env } = {}) {
  const bin = resolveBinary(env);
  if (!bin) {
    return { installed: false, guidance: buildGuidance(env) };
  }
  let version = "unknown";
  try {
    version = execFileSync(bin, ["--version"], { env, encoding: "utf8" }).trim();
  } catch {
    return { installed: false, guidance: buildGuidance(env), broken: true };
  }
  return { installed: true, binary: bin, version };
}

// Exported for tests that want to inspect the canonical scan order without
// hardcoding it in the test file.
export const WELL_KNOWN_INSTALL_PATHS = Object.freeze(WELL_KNOWN_PATHS.slice());
