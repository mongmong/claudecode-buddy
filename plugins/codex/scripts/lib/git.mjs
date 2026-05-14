import { execFileSync } from "node:child_process";

const MAX_BUFFER = 32 * 1024 * 1024; // 32 MB

export function runGit(cwd, args) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    return {
      ok: false,
      code: err.status ?? null,
      stderr,
      error: `git ${args.join(" ")} failed (code ${err.status ?? "?"}): ${stderr.trim() || err.message}`,
    };
  }
}

export function gitRepoRoot(cwd) {
  const r = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return r;
  return { ok: true, value: r.stdout.trim() };
}
