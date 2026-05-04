import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function writeFixture(dir, relPath, contents) {
  const fullPath = join(dir, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, contents);
  return fullPath;
}

export function runCompanion(args, env = {}) {
  return new Promise((resolve, reject) => {
    // Use process.execPath so tests that override PATH (to simulate a missing
    // opencode binary) don't accidentally break the spawn of node itself.
    const child = spawn(
      process.execPath,
      ["plugins/opencode/scripts/buddy.mjs", ...args],
      { env: { ...process.env, ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
