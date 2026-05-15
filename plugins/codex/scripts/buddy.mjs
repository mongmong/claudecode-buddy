#!/usr/bin/env node
// Plan-007 Phase 2+3 dispatcher for the codex plugin.
//
// Carries plan-006 forward from day 1:
//   - Phase 3 (C1): top-level .catch() on async dispatches.
//   - Phase 1 (H1): --no-ext-diff on all git diff calls (in lib/scope.mjs).
//   - Phase 2 (H2 + M1): fd-bound prompt-file via lib/fd-bound.mjs + openFdBound.
//   - Phase 5 (H3 + C2 + M2): two-layer SIGTERM in supervisor.mjs + pidIsOurSupervisor
//     extracted to lib/pid-identity.mjs.
//   - Test seams: CODEX_BUDDY_TEST_THROW, CODEX_BUDDY_TEST_PID_NEVER_OURS,
//     CODEX_BUDDY_TEST_SLOW_IMPORT_MS — used by tests; never activate in prod.
//
// Subcommands shipped:
//   Phase 2: setup, review, prompt, models.
//   Phase 3: run (foreground), run --background, status, result, cancel.
//   Phase 5: gate (added when Stop-hook gate lands).
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openFdBound } from "./lib/fd-bound.mjs";
import { detectCodex } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";
import { resolveScope, getDiff } from "./lib/scope.mjs";
import { buildReviewPrompt } from "./lib/prompt.mjs";
import { invokeCodex } from "./lib/invoke.mjs";
import { dispatchCodex } from "./lib/review-dispatch.mjs";
import {
  currentSessionKey,
  loadSessionId,
  deleteSessionId,
  acquireSessionLock,
  sessionLockPath,
} from "./lib/sessions.mjs";
import { verifySessionExists } from "./lib/session-capture.mjs";
import { extractTrailer } from "./lib/trailer.mjs";
import { splitArgs } from "./lib/args.mjs";
import { listModels } from "./lib/list-models.mjs";
import { createJob, updateJob, listJobs, loadJob, jobsDir, jobPath, JOB_ID_RE } from "./lib/jobs.mjs";
import { pidIsOurSupervisor as pidIsOurSupervisorExt } from "./lib/pid-identity.mjs";

const VALID_SCOPES = new Set(["auto", "working-tree", "branch"]);
const VALID_STYLES = new Set(["friendly", "adversarial"]);

function parseReviewArgs(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const out = { scope: "auto", base: "main", model: null, variant: null, sessionKey: null, reset: false, noSession: false, style: "friendly" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--scope requires a value (auto|working-tree|branch)" };
      if (!VALID_SCOPES.has(v)) {
        return { ok: false, error: `--scope value must be one of auto, working-tree, branch — got: ${JSON.stringify(v)}` };
      }
      out.scope = v;
    } else if (a === "--base") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--base requires a value (a git ref)" };
      out.base = v;
    } else if (a === "--model") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--model requires a value" };
      out.model = v;
    } else if (a === "--variant") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--variant requires a value (provider-specific reasoning effort, e.g. high|max|minimal)" };
      out.variant = v;
    } else if (a === "--session-key") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--session-key requires a value" };
      out.sessionKey = v;
    } else if (a === "--reset") {
      out.reset = true;
    } else if (a === "--no-session") {
      out.noSession = true;
    } else if (a === "--style") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--style requires a value (friendly|adversarial)" };
      if (!VALID_STYLES.has(v)) {
        return { ok: false, error: `--style value must be one of friendly, adversarial — got: ${JSON.stringify(v)}` };
      }
      out.style = v;
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --scope, --base, --model, --variant, --session-key, --reset, --no-session, --style.` };
    } else if (a.length > 0) {
      return { ok: false, error: `unexpected positional argument: ${a}. The review subcommand only accepts flag-style arguments.` };
    }
  }
  if (out.reset && out.noSession) {
    return { ok: false, error: "--reset and --no-session are mutually exclusive (reset is destructive; no-session is non-destructive)" };
  }
  return { ok: true, value: out };
}

function allowedPromptDir() {
  const tmp = process.env.TMPDIR || "/tmp";
  const resolver = realpathSync.native ?? realpathSync;
  try {
    return resolver(tmp) + "/codex-prompts";
  } catch {
    try {
      return resolver("/tmp") + "/codex-prompts";
    } catch {
      return "/tmp/codex-prompts";
    }
  }
}

function isUnderAllowedDir(filePath) {
  let resolved;
  try {
    resolved = realpathSync(filePath);
  } catch {
    return false;
  }
  const base = allowedPromptDir();
  return resolved === base || resolved.startsWith(base + "/");
}

function readPromptFileFdBound(path) {
  let opened;
  try {
    opened = openFdBound(path);
  } catch (err) {
    return { ok: false, error: `failed to open --prompt-file ${path}: ${err.message}` };
  }
  try {
    const base = allowedPromptDir();
    if (opened.fdResolvedPath !== null) {
      const realPath = opened.fdResolvedPath;
      if (realPath !== base && !realPath.startsWith(base + "/")) {
        return {
          ok: false,
          error:
            `--prompt-file path \`${path}\` resolves to \`${realPath}\` which is not under the allowed prompt directory ` +
            `(${base}). The subagent must write files via mktemp inside $TMPDIR/codex-prompts/.`,
        };
      }
    }
    return { ok: true, value: readFileSync(opened.fd, "utf8") };
  } finally {
    try { closeSync(opened.fd); } catch {}
  }
}

function parsePromptArgs(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  let promptFile = null;
  let model = null;
  let variant = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt-file") {
      promptFile = argv[++i];
      if (promptFile === undefined) return { ok: false, error: "--prompt-file requires a path argument" };
    } else if (a === "--model") {
      model = argv[++i];
      if (model === undefined) return { ok: false, error: "--model requires a value" };
    } else if (a === "--variant") {
      variant = argv[++i];
      if (variant === undefined) return { ok: false, error: "--variant requires a value" };
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --prompt-file, --model, --variant.` };
    } else if (a.length > 0) {
      positional.push(a);
    }
  }

  if (promptFile && positional.length > 0) {
    return { ok: false, error: "--prompt-file and positional prompt text are mutually exclusive" };
  }

  if (promptFile) {
    if (!isUnderAllowedDir(promptFile)) {
      return {
        ok: false,
        error:
          `--prompt-file path \`${promptFile}\` is not under the allowed prompt directory ` +
          `(${allowedPromptDir()}). The subagent must write prompt files via mktemp inside $TMPDIR/codex-prompts/.`,
      };
    }
    const r = readPromptFileFdBound(promptFile);
    if (!r.ok) return r;
    return { ok: true, text: r.value, model, variant };
  }
  return { ok: true, text: positional.join(" "), model, variant };
}

function emitTextOnly(text) {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

function emitParsedVerdict(parsed) {
  process.stdout.write(`verdict: ${parsed.verdict}\n`);
  if (parsed.blockers.length === 0) {
    process.stdout.write("blockers: []\n");
  } else {
    process.stdout.write("blockers:\n");
    for (const b of parsed.blockers) process.stdout.write(`  - ${b}\n`);
  }
}

function emitTextWithVerdict(text) {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write("\n---\n");
  const trailer = extractTrailer(text);
  if (trailer.ok) {
    emitParsedVerdict(trailer.value);
  } else {
    process.stdout.write(`verdict: needs-attention (parse error: ${trailer.error})\n`);
  }
}

function emitTextWithOptionalVerdict(text) {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  const trailer = extractTrailer(text);
  if (trailer.ok) {
    process.stdout.write("\n---\n");
    emitParsedVerdict(trailer.value);
  }
}

function runSetup() {
  const cli = detectCodex({ env: process.env });
  const lines = [];
  if (!cli.installed) {
    lines.push(`✗ codex is not installed.\n\n${cli.guidance}`);
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
  }
  lines.push(`✓ codex installed: ${cli.binary} (${cli.version})`);
  const cfg = detectConfig();
  if (!cfg.ok) {
    lines.push(`✗ config issue: ${cfg.error}`);
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
  }
  lines.push(`✓ default model configured: ${cfg.model} (from ${cfg.configPath})`);
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

function runModels() {
  const cfg = detectConfig();
  const configPath = cfg.ok ? cfg.configPath : defaultConfigPath();
  const r = listModels({ configPath });
  if (!r.ok) {
    process.stderr.write(`${r.error}\n`);
    process.exit(2);
  }
  for (const m of r.value) process.stdout.write(`${m}\n`);
  process.exit(0);
}

async function runReview(rawArgs) {
  // Plan-006 Phase 3 (C1) test seam carried forward from day 1.
  if (process.env.CODEX_BUDDY_TEST_THROW === "runReview") {
    throw new Error("CODEX_BUDDY_TEST_THROW=runReview simulated failure");
  }
  const parsed = parseReviewArgs(rawArgs);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const args = parsed.value;
  const cwd = process.env.CODEX_REPO_ROOT ?? process.cwd();

  const cli = detectCodex({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`codex is not installed.\n\n${cli.guidance}\n`);
    process.exit(0);
  }

  const resolved = resolveScope({ cwd, scope: args.scope, base: args.base });
  if (!resolved.ok) {
    process.stdout.write(`scope resolution failed:\n${resolved.error}\n\nverdict: needs-attention (git error)\n`);
    process.exit(0);
  }

  const diff = getDiff({ cwd, scope: resolved.value.scope, base: resolved.value.base });
  if (!diff.ok) {
    process.stdout.write(`diff retrieval failed:\n${diff.error}\n\nverdict: needs-attention (git error)\n`);
    process.exit(0);
  }
  if (!diff.value.trim()) {
    process.stdout.write("nothing to review — diff is empty\n\nverdict: approve (no changes)\n");
    process.exit(0);
  }

  const prompt = buildReviewPrompt({
    diff: diff.value,
    scope: resolved.value.scope,
    base: resolved.value.base,
    style: args.style,
  });

  // Phase 2 review path: always sandbox read-only (reviews never write).
  const invocation = await invokeCodex({
    binary: cli.binary,
    prompt,
    cwd,
    model: args.model,
    variant: args.variant,
    sandbox: "read-only",
  });

  if (!invocation.ok) {
    process.stdout.write(`codex invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }

  if (invocation.threadId) {
    process.stderr.write(`codex thread: ${invocation.threadId}\n`);
  }
  emitTextWithVerdict(invocation.text);
  process.exit(0);
}

async function runPrompt(rawArgs) {
  if (process.env.CODEX_BUDDY_TEST_THROW === "runPrompt") {
    throw new Error("CODEX_BUDDY_TEST_THROW=runPrompt simulated failure");
  }
  const input = parsePromptArgs(rawArgs);
  if (!input.ok) {
    process.stderr.write(`${input.error}\n`);
    process.exit(2);
  }
  if (input.text.trim().length === 0) {
    process.stderr.write("prompt subcommand requires non-empty prompt text\n");
    process.exit(2);
  }
  const cwd = process.env.CODEX_REPO_ROOT ?? process.cwd();
  const cli = detectCodex({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`codex is not installed.\n\n${cli.guidance}\n`);
    process.exit(0);
  }

  const model = input.model ?? process.env.CODEX_MODEL ?? null;
  const variant = input.variant ?? process.env.CODEX_VARIANT ?? null;

  // prompt subcommand: read-only sandbox (used by subagents for review-style dispatches).
  const invocation = await invokeCodex({
    binary: cli.binary,
    prompt: input.text,
    cwd,
    model,
    variant,
    sandbox: "read-only",
  });

  if (!invocation.ok) {
    process.stdout.write(`codex invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }
  emitTextWithOptionalVerdict(invocation.text);
  process.exit(0);
}

// =============================================================================
// Phase 3: /codex:run (foreground + background) + status/result/cancel
// =============================================================================

function parseRunArgs(rawArgs) {
  // Two distinct call shapes need to coexist:
  //   1. The slash-command wrapper passes "$ARGUMENTS" as ONE quoted token.
  //   2. Direct CLI / subagent / test calls pass each arg separately.
  // Heuristic: only an arg that BOTH starts with "--" AND contains whitespace
  // is a bundled CLI fragment.
  const argv = rawArgs.flatMap((a) =>
    a.startsWith("--") && /\s/.test(a) ? splitArgs(a) : [a],
  );
  let task = null;
  let taskFile = null;
  let model = null;
  let variant = null;
  let yolo = false;
  let background = false;
  let sessionKey = null;
  let reset = false;
  let noSession = false;
  let sandboxOverride = null;
  const seen = new Set();
  const guardDuplicate = (flag) => {
    if (seen.has(flag)) return { ok: false, error: `duplicate flag: ${flag} (already specified)` };
    seen.add(flag);
    return null;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") {
      const dup = guardDuplicate("--task"); if (dup) return dup;
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--task requires a value" };
      task = v;
    } else if (a === "--task-file") {
      const dup = guardDuplicate("--task-file"); if (dup) return dup;
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--task-file requires a path argument" };
      taskFile = v;
    } else if (a === "--model") {
      const dup = guardDuplicate("--model"); if (dup) return dup;
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--model requires a value" };
      model = v;
    } else if (a === "--variant") {
      const dup = guardDuplicate("--variant"); if (dup) return dup;
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--variant requires a value" };
      variant = v;
    } else if (a === "--sandbox") {
      const dup = guardDuplicate("--sandbox"); if (dup) return dup;
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--sandbox requires a value (read-only|workspace-write|danger-full-access)" };
      if (!["read-only", "workspace-write", "danger-full-access"].includes(v)) {
        return { ok: false, error: `--sandbox value must be one of read-only, workspace-write, danger-full-access — got: ${JSON.stringify(v)}` };
      }
      sandboxOverride = v;
    } else if (a === "--session-key") {
      const dup = guardDuplicate("--session-key"); if (dup) return dup;
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--session-key requires a value" };
      sessionKey = v;
    } else if (a === "--reset") {
      reset = true;
    } else if (a === "--no-session") {
      noSession = true;
    } else if (a === "--yolo") {
      yolo = true;
    } else if (a === "--background") {
      background = true;
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --task, --task-file, --model, --variant, --sandbox, --yolo, --background, --session-key, --reset, --no-session.` };
    } else if (a.length > 0) {
      return { ok: false, error: `unexpected positional argument: ${a}. Use --task or --task-file.` };
    }
  }
  if (task === null && taskFile === null) {
    return { ok: false, error: "run requires --task <text> or --task-file <path-under-$TMPDIR/codex-prompts/>" };
  }
  if (task !== null && taskFile !== null) {
    return { ok: false, error: "--task and --task-file are mutually exclusive" };
  }
  if (reset && noSession) {
    return { ok: false, error: "--reset and --no-session are mutually exclusive" };
  }
  // R11 sandbox decision (Phase 1.5 gate 4): /codex:run default is read-only;
  // --yolo upgrades to workspace-write; --sandbox flag is an explicit override
  // (overrides --yolo's choice if both present).
  let sandbox = sandboxOverride ?? (yolo ? "workspace-write" : "read-only");
  if (taskFile !== null) {
    // Plan-006 round-1 fix: path-based containment FIRST (R11 macOS regression).
    if (!isUnderAllowedDir(taskFile)) {
      return {
        ok: false,
        error:
          `--task-file path \`${taskFile}\` is not under the allowed prompt directory ` +
          `(${allowedPromptDir()}). The subagent must write task files via mktemp ` +
          `inside $TMPDIR/codex-prompts/.`,
      };
    }
    const safeRead = readTaskFileFdBound(taskFile);
    if (!safeRead.ok) return { ok: false, error: safeRead.error };
    task = safeRead.value;
  }
  return { ok: true, value: { task, model, variant, yolo, background, sessionKey, reset, noSession, sandbox } };
}

function readTaskFileFdBound(path) {
  let opened;
  try {
    opened = openFdBound(path);
  } catch (err) {
    return { ok: false, error: `failed to open --task-file ${path}: ${err.message}` };
  }
  try {
    const base = allowedPromptDir();
    if (opened.fdResolvedPath !== null) {
      const realPath = opened.fdResolvedPath;
      if (realPath !== base && !realPath.startsWith(base + "/")) {
        return {
          ok: false,
          error:
            `--task-file path \`${path}\` resolves to \`${realPath}\` which is not under the allowed prompt directory ` +
            `(${base}). The subagent must write files via mktemp inside $TMPDIR/codex-prompts/.`,
        };
      }
    }
    return { ok: true, value: readFileSync(opened.fd, "utf8") };
  } finally {
    try { closeSync(opened.fd); } catch {}
  }
}

function diffSummary(cwd) {
  try {
    // Plan-006 H1: --no-ext-diff defense-in-depth on all git diff calls.
    const unstaged = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--stat"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const staged = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--stat"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    if (unstaged.trim()) out += unstaged.trim() + "\n";
    if (staged.trim()) out += staged.trim() + "\n";
    if (untracked.trim()) {
      out += "Untracked:\n";
      for (const path of untracked.trim().split("\n")) out += `  ${path}\n`;
    }
    if (out.length === 0) return "(no changes)\n";
    return out;
  } catch {
    return "(diff summary unavailable — not a git repo or git missing)\n";
  }
}

function pidIsOurSupervisor(pid, jobId) {
  // Plan-006 Phase 5 (C2 + M2): delegates to lib/pid-identity.mjs.
  // Test seam: CODEX_BUDDY_TEST_PID_NEVER_OURS=1 forces false (PID-reuse simulation).
  if (process.env.CODEX_BUDDY_TEST_PID_NEVER_OURS === "1") return false;
  return pidIsOurSupervisorExt(pid, jobId);
}

async function runRun(rawArgs) {
  if (process.env.CODEX_BUDDY_TEST_THROW === "runRun") {
    throw new Error("CODEX_BUDDY_TEST_THROW=runRun simulated failure");
  }
  const parsed = parseRunArgs(rawArgs);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const args = parsed.value;
  const cwd = process.env.CODEX_REPO_ROOT ?? process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;

  // Non-interactive --yolo guard (parity with opencode).
  const isInteractive = process.stderr.isTTY || process.env.CODEX_BUDDY_FORCE_INTERACTIVE === "1";
  if (!args.yolo && !isInteractive && !args.background && args.sandbox !== "read-only") {
    // Only block when the chosen sandbox could trigger a prompt that nobody
    // can answer. For codex, sandbox read-only never prompts (read-only),
    // workspace-write is silent-allow (per gate 4), danger-full-access is
    // explicit-opt-in. So the guard mainly matters for danger-full-access
    // via explicit --sandbox override without --yolo in non-interactive context.
    process.stderr.write(
      `run requires --yolo when --sandbox=${args.sandbox} is used in a non-interactive context.\n`,
    );
    process.exit(2);
  }
  if (args.background && !args.yolo && args.sandbox === "read-only") {
    // Background read-only run is fine — no writes, no prompts. Allow it.
  } else if (args.background && !args.yolo) {
    process.stderr.write(
      "--background with a writable --sandbox requires --yolo. Background runs cannot answer interactive prompts.\n",
    );
    process.exit(2);
  }

  const cli = detectCodex({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`codex is not installed.\n\n${cli.guidance}\n`);
    process.exit(0);
  }

  if (args.background) {
    return runRunBackground(args, cwd, projectDir, cli);
  }

  // Foreground: synchronous dispatch via review-dispatch (session continuity).
  const job = createJob(projectDir, {
    kind: "run",
    model: args.model,
    pid: null, // foreground; no separate process to cancel
    summary: args.task.split("\n")[0].slice(0, 80),
  });

  const invocation = await dispatchCodex({
    binary: cli.binary,
    cwd,
    projectDir,
    role: "run",
    model: args.model,
    variant: args.variant,
    sandbox: args.sandbox,
    prompt: args.task,
    sessionKeyOverride: args.sessionKey ?? null,
    reset: args.reset ?? false,
    noSession: args.noSession ?? false,
  });

  if (!invocation.ok) {
    updateJob(projectDir, job.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      exit_code: invocation.exit_code ?? null,
    });
    process.stdout.write(`codex invocation failed:\n${invocation.error}\n`);
    process.exit(0);
  }

  updateJob(projectDir, job.id, {
    status: "completed",
    finished_at: new Date().toISOString(),
    exit_code: 0,
  });

  if (invocation.threadId) {
    process.stderr.write(
      `codex thread: ${invocation.threadId} ` +
      `(key=${invocation.sessionKey}; --session-key to override; --reset to start fresh)\n`,
    );
  }
  emitTextOnly(invocation.text);
  process.stdout.write("\n---\nFiles changed:\n");
  process.stdout.write(diffSummary(cwd));
  process.exit(0);
}

function runRunBackground(args, cwd, projectDir, cli) {
  const job = createJob(projectDir, {
    kind: "run",
    model: args.model,
    summary: args.task.split("\n")[0].slice(0, 80),
  });

  const key = currentSessionKey({ cwd, override: args.sessionKey });
  let degraded = false;
  let resumeId = null;
  let lockAcquired = false;

  if (args.noSession) {
    degraded = true;
  } else {
    const lock = acquireSessionLock(projectDir, key, "run", args.model);
    if (!lock.ok) {
      process.stderr.write(
        `warn: another codex dispatch holds the session lock for ${key}/run/${args.model}; ` +
        `running this background job without session continuity to avoid race.\n`,
      );
      if (args.reset) {
        process.stderr.write(`warn: --reset ignored because another dispatch holds the lock\n`);
      }
      degraded = true;
    } else {
      lockAcquired = true;
      if (args.reset) deleteSessionId(projectDir, key, "run", args.model);
      let storedId = loadSessionId(projectDir, key, "run", args.model).value;
      if (storedId !== null) {
        const verify = verifySessionExists(cli.binary, storedId);
        if (verify.ok && !verify.exists) {
          deleteSessionId(projectDir, key, "run", args.model);
          storedId = null;
        }
      }
      resumeId = storedId;
    }
  }

  // Build codex argv. Resume path uses different argv shape per Phase 1.5 gate 3.
  let codexArgs;
  if (resumeId !== null) {
    codexArgs = [
      "exec", "resume", "--json", "--skip-git-repo-check",
      "-c", `sandbox.mode=${args.sandbox}`,
    ];
    if (args.model) codexArgs.push("--model", args.model);
    if (args.variant) codexArgs.push("-c", `model_reasoning_effort=${args.variant}`);
    codexArgs.push(resumeId, args.task);
  } else {
    codexArgs = [
      "exec", "--json", "--skip-git-repo-check",
      "--sandbox", args.sandbox,
      "-C", cwd,
    ];
    if (args.model) codexArgs.push("--model", args.model);
    if (args.variant) codexArgs.push("-c", `model_reasoning_effort=${args.variant}`);
    codexArgs.push(args.task);
  }

  const supervisorPath = join(dirname(fileURLToPath(import.meta.url)), "lib", "supervisor.mjs");

  const supervisor = spawn(
    process.execPath,
    [
      supervisorPath,
      job.id,
      projectDir,
      cli.binary,
      cwd,
      "run",
      key,
      args.model ?? "",
      String(!!args.noSession),
      String(degraded),
      ...codexArgs,
    ],
    { detached: true, stdio: "ignore" },
  );
  supervisor.unref();

  if (lockAcquired) {
    let ownershipTransferred = false;
    supervisor.once("error", (err) => {
      if (ownershipTransferred) return;
      try { rmSync(sessionLockPath(projectDir, key, "run", args.model), { recursive: true, force: true }); } catch {}
      process.stderr.write(`error: failed to spawn supervisor: ${err.message}\n`);
    });
    supervisor.once("spawn", () => { ownershipTransferred = true; });
  }

  updateJob(projectDir, job.id, {
    pid: supervisor.pid,
    pgid: supervisor.pid,
    stdout_path: join(jobsDir(projectDir), `${job.id}.stdout`),
    stderr_path: join(jobsDir(projectDir), `${job.id}.stderr`),
    events_path: join(jobsDir(projectDir), `${job.id}.events`),
  });

  process.stdout.write(`Started job ${job.id} in the background (pid ${supervisor.pid}).\n`);
  if (resumeId) {
    process.stdout.write(`Resuming codex thread: ${resumeId} (key=${key})\n`);
  } else if (degraded) {
    process.stdout.write(`(degraded: running without session continuity)\n`);
  }
  process.stdout.write(`Use \`/codex:status\` to check, \`/codex:result ${job.id}\` for output.\n`);
  process.exit(0);
}

function elapsedHuman(startIso, finishIso) {
  if (!startIso) return "?";
  const start = new Date(startIso).getTime();
  const end = finishIso ? new Date(finishIso).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function runStatus(rawArgs) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const list = listJobs(projectDir);
  if (!list.ok) {
    process.stderr.write(`${list.error}\n`);
    process.exit(2);
  }
  if (list.value.length === 0) {
    process.stdout.write("(no codex jobs)\n");
    process.exit(0);
  }
  for (const j of list.value) {
    const alive = j.status === "running" && j.pid ? (isAlive(j.pid) ? " [alive]" : " [dead]") : "";
    process.stdout.write(
      `${j.id}  ${j.status}${alive}  ${j.kind}  ${j.model ?? "-"}  ` +
      `started=${j.started_at}  elapsed=${elapsedHuman(j.started_at, j.finished_at)}  ` +
      `${j.summary ?? ""}\n`,
    );
  }
  process.exit(0);
}

function runResult(rawArgs) {
  const id = rawArgs[0];
  if (!id) {
    process.stderr.write("result requires a job id\n");
    process.exit(2);
  }
  if (!JOB_ID_RE.test(id)) {
    process.stderr.write(`invalid job id format: ${JSON.stringify(id)}\n`);
    process.exit(2);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const loaded = loadJob(projectDir, id);
  if (!loaded.ok) {
    process.stderr.write(`${loaded.error}\n`);
    process.exit(2);
  }
  const job = loaded.value;
  process.stdout.write(`Job ${job.id}  status=${job.status}  exit_code=${job.exit_code}\n`);
  process.stdout.write(`started=${job.started_at}  finished=${job.finished_at ?? "(running)"}\n`);
  if (job.stdout_path) {
    try {
      const text = readFileSync(job.stdout_path, "utf8");
      process.stdout.write("\n--- stdout (parsed assistant text) ---\n");
      process.stdout.write(text);
      if (!text.endsWith("\n")) process.stdout.write("\n");
    } catch (err) {
      process.stdout.write(`\n(stdout unavailable: ${err.message})\n`);
    }
  }
  process.exit(0);
}

function runCancel(rawArgs) {
  const id = rawArgs[0];
  if (!id) {
    process.stderr.write("cancel requires a job id\n");
    process.exit(2);
  }
  if (!JOB_ID_RE.test(id)) {
    process.stderr.write(`invalid job id format: ${JSON.stringify(id)}\n`);
    process.exit(2);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const loaded = loadJob(projectDir, id);
  if (!loaded.ok) {
    process.stdout.write(`${loaded.error}\n`);
    process.exit(0);
  }
  const job = loaded.value;
  if (job.status === "completed" || job.status === "failed") {
    process.stdout.write(`job ${id} already ${job.status} (no-op)\n`);
    process.exit(0);
  }
  if (job.status === "cancelled") {
    process.stdout.write(`job ${id} already cancelled (no-op)\n`);
    process.exit(0);
  }
  if (job.pid === null) {
    process.stdout.write(`cannot cancel foreground job ${id} — pid is null (the synchronous shell owns it)\n`);
    process.exit(0);
  }
  if (!pidIsOurSupervisor(job.pid, id)) {
    // PID is dead or recycled. Just mark cancelled without signaling.
    const r = updateJob(projectDir, id, {
      status: "cancelled",
      finished_at: new Date().toISOString(),
      exit_code: null,
    }, { expectedStatus: ["running", "session-ended"] });
    if (!r.ok) {
      process.stdout.write(`job ${id} finished before cancel could apply (${r.error})\n`);
      process.exit(0);
    }
    process.stdout.write(`job ${id} pid ${job.pid} is no longer our supervisor (likely PID-reuse or already exited); marked cancelled\n`);
    process.exit(0);
  }
  // SIGTERM the supervisor's process group; supervisor's SIGTERM handler
  // releases the lock + marks the job cancelled.
  try { process.kill(-(job.pgid ?? job.pid), "SIGTERM"); } catch {}
  process.stdout.write(`SIGTERMed supervisor pgid=${job.pgid ?? job.pid} (job ${id}); cancelled\n`);
  process.exit(0);
}

const subcommand = process.argv[2];
const rest = process.argv.slice(3);

// Plan-006 Phase 3 (C1) .catch wrappers — carried forward from day 1.
switch (subcommand) {
  case "setup":
    runSetup();
    break;
  case "models":
    runModels();
    break;
  case "review":
    runReview(rest).catch((err) => {
      process.stderr.write(`unhandled error in review: ${err.stack ?? err.message ?? err}\n`);
      process.exit(2);
    });
    break;
  case "prompt":
    runPrompt(rest).catch((err) => {
      process.stderr.write(`unhandled error in prompt: ${err.stack ?? err.message ?? err}\n`);
      process.exit(2);
    });
    break;
  case "run":
    runRun(rest).catch((err) => {
      process.stderr.write(`unhandled error in run: ${err.stack ?? err.message ?? err}\n`);
      process.exit(2);
    });
    break;
  case "status":
    runStatus(rest);
    break;
  case "result":
    runResult(rest);
    break;
  case "cancel":
    runCancel(rest);
    break;
  default:
    if (subcommand === undefined) {
      process.stderr.write("usage: codex-buddy <subcommand> [args...]\n\nSubcommands: setup, models, review, prompt, run, status, result, cancel\n");
    } else {
      process.stderr.write(`unknown subcommand: ${subcommand}\n\nUse one of: setup, models, review, prompt, run, status, result, cancel\n`);
    }
    process.exit(2);
}
