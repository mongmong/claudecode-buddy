import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { runGit, gitRepoRoot } from "./git.mjs";

const MAX_UNTRACKED_BYTES = 1024 * 1024; // 1 MB
const BINARY_SNIFF_BYTES = 8192;

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function looksBinary(buf) {
  const sniff = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  return sniff.includes(0x00);
}

function checkRepo(cwd) {
  const root = gitRepoRoot(cwd);
  if (!root.ok) return fail(`not a git repo: ${root.error}`);
  return ok(root.value);
}

function checkBase(cwd, base) {
  const r = runGit(cwd, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (!r.ok) return fail(`base ref \`${base}\` does not exist: ${r.error}`);
  return ok(true);
}

function hasWorkingTreeChanges(cwd) {
  const r = runGit(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!r.ok) return false;
  return r.stdout.trim().length > 0;
}

function hasBranchDivergence(cwd, base) {
  const r = runGit(cwd, ["diff", "--shortstat", `${base}...HEAD`]);
  if (!r.ok) return false;
  return r.stdout.trim().length > 0;
}

export function resolveScope({ cwd, scope, base }) {
  const resolvedBase = base ?? "main";
  const repoCheck = checkRepo(cwd);
  if (!repoCheck.ok) return repoCheck;

  if (scope === "branch") {
    const baseCheck = checkBase(cwd, resolvedBase);
    if (!baseCheck.ok) return baseCheck;
    return ok({ scope: "branch", base: resolvedBase });
  }
  if (scope === "working-tree") {
    return ok({ scope: "working-tree", base: resolvedBase });
  }
  // auto
  if (hasWorkingTreeChanges(cwd)) {
    return ok({ scope: "working-tree", base: resolvedBase });
  }
  // Tree is clean. Auto wants to try branch — but if base is missing, do not silently
  // fall back to "no diff = approve". Surface the base error so the user knows why
  // auto could not find anything to review.
  const baseCheck = checkBase(cwd, resolvedBase);
  if (!baseCheck.ok) {
    return fail(
      `scope=auto: working tree is clean and base ref \`${resolvedBase}\` does not exist. ` +
      `Specify --scope branch --base <existing-ref> with a valid ref, or make a working-tree change. ` +
      `(${baseCheck.error})`,
    );
  }
  if (hasBranchDivergence(cwd, resolvedBase)) {
    return ok({ scope: "branch", base: resolvedBase });
  }
  // Tree clean AND no divergence from a real base — there is genuinely nothing to review.
  return ok({ scope: "working-tree", base: resolvedBase });
}

function readUntrackedAsDiff(cwd, paths) {
  let out = "";
  for (const path of paths) {
    const fullPath = join(cwd, path);
    let stat;
    try {
      // Use lstatSync (not statSync) so symlinks don't cause us to read their
      // targets — an untracked symlink like `leak -> ~/.ssh/config` would
      // otherwise inline that external file into the prompt sent to opencode.
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      out += `\n# untracked: ${path} skipped (symlink)\n`;
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_UNTRACKED_BYTES) {
      out += `\n# untracked: ${path} skipped (size ${stat.size} bytes exceeds 1 MB cap)\n`;
      continue;
    }
    let buf;
    try {
      buf = readFileSync(fullPath);
    } catch {
      continue;
    }
    if (looksBinary(buf)) {
      out += `\n# untracked: ${path} skipped (binary)\n`;
      continue;
    }
    const content = buf.toString("utf8");
    out += `\n--- /dev/null\n+++ b/${path}\n`;
    for (const line of content.split("\n")) {
      out += `+${line}\n`;
    }
  }
  return out;
}

export function getDiff({ cwd, scope, base }) {
  const repoCheck = checkRepo(cwd);
  if (!repoCheck.ok) return repoCheck;

  if (scope === "branch") {
    const resolvedBase = base ?? "main";
    const baseCheck = checkBase(cwd, resolvedBase);
    if (!baseCheck.ok) return baseCheck;
    const r = runGit(cwd, ["diff", `${resolvedBase}...HEAD`]);
    if (!r.ok) return fail(r.error);
    return ok(r.stdout);
  }
  // working-tree
  const staged = runGit(cwd, ["diff", "--cached"]);
  const unstaged = runGit(cwd, ["diff"]);
  const untrackedList = runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!staged.ok) return fail(staged.error);
  if (!unstaged.ok) return fail(unstaged.error);
  if (!untrackedList.ok) return fail(untrackedList.error);
  const untrackedDiff = readUntrackedAsDiff(
    cwd,
    untrackedList.stdout.split("\n").filter(Boolean),
  );
  const combined = [staged.stdout, unstaged.stdout, untrackedDiff]
    .filter((s) => s.trim())
    .join("\n");
  return ok(combined);
}
