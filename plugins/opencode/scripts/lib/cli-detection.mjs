import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Well-known install locations the official opencode installer or common
// package managers drop the binary into. Scanned in order; the first
// existing + executable hit wins. Order favors the official installer
// path (~/.opencode/bin) since that's where `curl https://opencode.ai/install`
// puts it, then per-user package managers, then system paths.
//
// Entries beginning with "~/" are expanded against env.HOME (lazy, so
// tests can inject a fake HOME without touching the real one).
const WELL_KNOWN_PATHS = [
  "~/.opencode/bin/opencode",
  "~/.local/bin/opencode",
  "~/.bun/bin/opencode",
  "~/.npm-global/bin/opencode",
  "~/.npm/bin/opencode",
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
  "/usr/bin/opencode",
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
    // Use accessSync(X_OK) instead of a raw mode-bit check — accessSync
    // tests whether the *calling process* can execute the file (honors
    // owner / group / other split via real uid/gid), where (mode & 0o111)
    // would accept a file executable by some other user but not us.
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

function pathHasOpencode(env) {
  try {
    execFileSync("opencode", ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function resolveBinary(env) {
  if (env.OPENCODE_BIN) {
    if (existsSync(env.OPENCODE_BIN)) return env.OPENCODE_BIN;
    return null;
  }
  if (pathHasOpencode(env)) return "opencode";
  const fromScan = scanWellKnownPaths(env);
  if (fromScan) return fromScan;
  return null;
}

function buildGuidance(env) {
  const expanded = WELL_KNOWN_PATHS
    .map((p) => expandHome(p, env.HOME))
    .filter(Boolean);
  return `opencode is not installed or not reachable.

Install: \`curl -fsSL https://opencode.ai/install | bash\`
Then verify: \`opencode --version\`

Looked for the binary in:
  - \`opencode\` on PATH
${expanded.map((p) => `  - ${p}`).join("\n")}

If opencode is installed at a non-standard path, set OPENCODE_BIN to the absolute binary path.`;
}

export function detectOpencode({ env = process.env } = {}) {
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
