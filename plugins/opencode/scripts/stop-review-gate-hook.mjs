#!/usr/bin/env node
// Stop-hook review gate for the opencode plugin.
//
// CRITICAL ESM ORDERING (per plan-002 supervisor.mjs precedent):
// 1. Static imports of node:* built-ins ONLY (cannot fail at module load).
// 2. Register fail-open uncaughtException + unhandledRejection handlers.
// 3. Dynamic `await import(...)` for our own modules — those CAN throw at
//    module-load time (syntax / circular / missing file). The handlers above
//    will catch the throw and fail open.
//
// Threat model (see D-011): this is an advisory development gate, NOT a
// security control. Failing open keeps users productive when the review
// system itself is broken; failing closed would strand users. For genuine
// security gating use a CI-level enforcement, not this hook.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_TIMEOUT_MS = 15 * 60 * 1000; // outer ceiling; inner dispatcher timeout (5min) fires first

// Top-level fail-open handlers — registered BEFORE any code that could throw.
process.on("uncaughtException", (err) => {
  process.stderr.write(`stop-gate: uncaughtException (${err.message}); failing open\n`);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`stop-gate: unhandledRejection (${err?.message ?? err}); failing open\n`);
  process.exit(0);
});

// Dynamic imports — handlers are registered, so any throws here trigger
// the fail-open path.
const { loadConfig } = await import("./lib/config.mjs");
const { dispatchOpencode } = await import("./lib/review-dispatch.mjs");
const { detectOpencode } = await import("./lib/cli-detection.mjs");
const { extractTrailer } = await import("./lib/trailer.mjs");

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  } catch {}
  return {};
}

// Authoritative actionable-turn signal: git working-tree state.
// Returns { go: true|false, reason }.
function checkActionable(cwd) {
  // Pre-check .git existence. Cheap; doesn't depend on stderr capture for
  // distinguishing non-git from wedged-git (per plan-003 round-3 review).
  if (!existsSync(joinPath(cwd, ".git"))) {
    return { go: true, reason: "non-git workspace; gate runs without git-state filter" };
  }
  let porcelain;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    });
  } catch (err) {
    // .git exists but git itself failed (binary missing, timeout, lock contention).
    // Don't run a review whose prompt asks the model to query the same broken git.
    const code = err.code ?? "";
    const stderr = (err.stderr ?? "").toString().slice(0, 80);
    if (code === "ENOENT") {
      return { go: false, reason: "git binary not installed; skipping review (cannot read diff)" };
    }
    return { go: false, reason: `git state check failed (${code}: ${stderr}); skipping rather than running review on wedged git` };
  }
  const lines = porcelain.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { go: false, reason: "no working-tree, staged, or untracked changes" };
  // Meta-skip: only changes are under .claudecode-buddy/ (the dispatcher's
  // own session-id writes during plan/code review work).
  if (lines.every((l) => /^.. \.claudecode-buddy\//.test(l))) {
    return { go: false, reason: "only .claudecode-buddy/ session-id changes (dispatcher self-edit)" };
  }
  return { go: true, reason: `${lines.length} working-tree change(s)` };
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

function logWarn(msg) {
  process.stderr.write(`stop-gate: ${msg}\n`);
}

const INLINE_STOP_GATE_PROMPT = [
  "You are a code-review gate.",
  "",
  "The user just finished a Claude Code turn. Review the assistant's last message AND the working-tree state. If this is a git repo, run `git diff HEAD` and `git status` to see what actually changed; if it's not (no `.git/` directory), inspect files directly via Read/Glob/Grep — the file system itself is your source of truth.",
  "",
  "Look for: claims that don't match reality (\"tests pass\" → tests must exist + actually run + actually pass); obvious diff issues (incomplete edits, broken imports, syntax errors); unacknowledged side effects (commits, pushes, deletions).",
  "",
  "Output Markdown findings followed by a JSON trailer:",
  "```json",
  '{"verdict": "approve" | "needs-attention", "blockers": [string]}',
  "```",
  "",
  "approve only when the assistant's claims match reality. needs-attention for any mismatch — be honest. Three findings max.",
].join("\n");

function buildStopGatePrompt(cwd, lastMsg) {
  const PROMPTS_DIR = joinPath(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
  const templatePath = joinPath(PROMPTS_DIR, "stop-review-gate.md");
  let template;
  try {
    template = readFileSync(templatePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      template = INLINE_STOP_GATE_PROMPT;
    } else {
      throw err; // propagate to fail-open via uncaughtException
    }
  }
  const snippet = lastMsg.length > 0
    ? `\n\nPrevious Claude response:\n${lastMsg.slice(0, 8000)}\n`
    : "\n\n(no last assistant message provided)\n";
  return template + snippet;
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectDir = cwd;

  const cfg = loadConfig(projectDir);
  if (!cfg.ok) {
    logWarn(`config load failed: ${cfg.error}; failing open`);
    process.exit(0);
  }
  if (!cfg.value.stopReviewGate) process.exit(0); // opt-out path: gate is OFF

  const lastMsg = String(input.last_assistant_message ?? "");
  const action = checkActionable(cwd);
  if (!action.go) {
    logWarn(`skipping gate (${action.reason})`);
    process.exit(0);
  }

  const cli = detectOpencode({ env: process.env });
  if (!cli.installed) {
    logWarn(`opencode not installed; failing open`);
    process.exit(0);
  }

  const prompt = buildStopGatePrompt(cwd, lastMsg);

  let result;
  try {
    result = await Promise.race([
      dispatchOpencode({
        binary: cli.binary,
        cwd,
        projectDir,
        role: "stop-gate",
        model: null,
        prompt,
        opencodeArgs: ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("hook outer timeout")), HOOK_TIMEOUT_MS)),
    ]);
  } catch (err) {
    logWarn(`review failed (${err.message}); failing open`);
    process.exit(0);
  }

  if (!result.ok || !(result.text ?? "").trim()) {
    logWarn(`review returned no text (${result.error ?? "empty body"}); failing open`);
    process.exit(0);
  }

  const trailer = extractTrailer(result.text);
  if (!trailer.ok) {
    logWarn(`trailer parse failed (${trailer.error}); failing open`);
    process.exit(0);
  }

  if (trailer.value.verdict === "approve") process.exit(0);

  // verdict === "needs-attention" → block Claude's stop with the findings.
  // Trailer schema permits an empty blockers[] array even when the verdict
  // is needs-attention (model said "needs attention but didn't list specifics").
  // Render the count explicitly so the message reads cleanly in both cases.
  const blockers = (trailer.value.blockers ?? []).slice(0, 3);
  const summary = blockers.length > 0
    ? `Stop-hook review gate found ${blockers.length} concern(s):\n` + blockers.map((b) => `- ${b}`).join("\n")
    : `Stop-hook review gate flagged the turn as needs-attention (no specific blockers listed):`;
  const reason = `${summary}\n\nFull review:\n${result.text}`;
  emitBlock(reason);
}

main().catch((err) => {
  logWarn(`unexpected main() error (${err.message}); failing open`);
  process.exit(0);
});
