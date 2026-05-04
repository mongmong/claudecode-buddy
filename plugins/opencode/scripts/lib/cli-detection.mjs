import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const INSTALL_GUIDANCE = `opencode is not installed or not on PATH.

Install: \`curl -fsSL https://opencode.ai/install | bash\`
Then verify: \`opencode --version\`

If opencode is installed at a non-standard path, set OPENCODE_BIN to the absolute binary path.`;

function resolveBinary(env) {
  if (env.OPENCODE_BIN) {
    if (existsSync(env.OPENCODE_BIN)) return env.OPENCODE_BIN;
    return null;
  }
  try {
    execFileSync("opencode", ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    return "opencode";
  } catch {
    return null;
  }
}

export function detectOpencode({ env = process.env } = {}) {
  const bin = resolveBinary(env);
  if (!bin) {
    return { installed: false, guidance: INSTALL_GUIDANCE };
  }
  let version = "unknown";
  try {
    version = execFileSync(bin, ["--version"], { env, encoding: "utf8" }).trim();
  } catch {
    return { installed: false, guidance: INSTALL_GUIDANCE, broken: true };
  }
  return { installed: true, binary: bin, version };
}
