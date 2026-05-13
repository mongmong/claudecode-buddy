#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { closeSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openFdBound } from "./lib/fd-bound.mjs";
import { detectOpencode } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";
import { loadConfig, updateConfig } from "./lib/config.mjs";
import { resolveScope, getDiff } from "./lib/scope.mjs";
import { buildReviewPrompt } from "./lib/prompt.mjs";
import { invokeOpencode, invokeOpencodeRaw } from "./lib/invoke.mjs";
import { dispatchOpencode } from "./lib/review-dispatch.mjs";
import {
  currentSessionKey,
  loadSessionId,
  deleteSessionId,
  acquireSessionLock,
  sessionLockPath,
} from "./lib/sessions.mjs";
import { verifySessionExists } from "./lib/session-capture.mjs";
import { rmSync } from "node:fs";
import { extractTrailer } from "./lib/trailer.mjs";
import { splitArgs } from "./lib/args.mjs";
import { listModels } from "./lib/list-models.mjs";
import { createJob, updateJob, listJobs, loadJob, jobsDir, jobPath, JOB_ID_RE } from "./lib/jobs.mjs";

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
      if (v === undefined) return { ok: false, error: "--model requires a value (provider/model)" };
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
    return resolver(tmp) + "/opencode-prompts";
  } catch {
    try {
      return resolver("/tmp") + "/opencode-prompts";
    } catch {
      return "/tmp/opencode-prompts";
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

// Plan-006 Phase 2: refactored to use the openFdBound primitive. Two
// readers (`readTaskFileFdBound`, `readPromptFileFdBound`) share the same
// open + read mechanics; they differ only in error-message labels.
// On Linux, the fd-resolved-path is validated against the allowed dir
// (closes H2 TOCTOU). On macOS, fdResolvedPath is null and we fall back
// to path-based isUnderAllowedDir only — existing macOS known-limitation.
function readFileFdBoundWithLabel(path, label) {
  let opened;
  try {
    opened = openFdBound(path);
  } catch (err) {
    return { ok: false, error: `failed to open ${label} file ${path}: ${err.message}` };
  }
  try {
    const base = allowedPromptDir();
    // Always run path-based isUnderAllowedDir-equivalent on the fd-resolved
    // path when available; on macOS, fall back to the caller's prior
    // path-based check (already run before this function by isUnderAllowedDir).
    if (opened.fdResolvedPath !== null) {
      const realPath = opened.fdResolvedPath;
      if (realPath !== base && !realPath.startsWith(base + "/")) {
        return {
          ok: false,
          error:
            `${label} path \`${path}\` resolves to \`${realPath}\` which is not under the allowed prompt directory ` +
            `(${base}). The subagent must write files via mktemp inside $TMPDIR/opencode-prompts/.`,
        };
      }
    }
    return { ok: true, value: readFileSync(opened.fd, "utf8") };
  } finally {
    try { closeSync(opened.fd); } catch {}
  }
}

function readTaskFileFdBound(path) {
  return readFileFdBoundWithLabel(path, "--task-file");
}

function readPromptFileFdBound(path) {
  return readFileFdBoundWithLabel(path, "--prompt-file");
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
      if (model === undefined) return { ok: false, error: "--model requires a provider/model argument" };
    } else if (a === "--variant") {
      variant = argv[++i];
      if (variant === undefined) return { ok: false, error: "--variant requires a value (provider-specific reasoning effort, e.g. high|max|minimal)" };
    } else if (a === "--stdin") {
      return {
        ok: false,
        error:
          "--stdin is not supported in plan 000 (deferred for security review). " +
          "Use --prompt-file <path-under-$TMPDIR/opencode-prompts/> instead.",
      };
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --prompt-file, --model, --variant.` };
    } else if (a.length > 0) {
      positional.push(a);
    }
  }

  if (promptFile && positional.length > 0) {
    return {
      ok: false,
      error: "--prompt-file and positional prompt text are mutually exclusive",
    };
  }

  if (promptFile) {
    if (!isUnderAllowedDir(promptFile)) {
      return {
        ok: false,
        error:
          `--prompt-file path \`${promptFile}\` is not under the allowed prompt directory ` +
          `(${allowedPromptDir()}). The subagent must write prompt files via mktemp ` +
          `inside $TMPDIR/opencode-prompts/.`,
      };
    }
    // Plan-006 Phase 2 (H2): fd-bound read closes the symlink-swap TOCTOU
    // window between isUnderAllowedDir's realpathSync(path) above and the
    // actual read. On Linux, readPromptFileFdBound also validates the
    // fd-resolved-path against the allowed dir (defense in depth). On macOS,
    // the fd-bound check is skipped; macOS retains the prior TOCTOU
    // known-limitation (path-based check only).
    const r = readPromptFileFdBound(promptFile);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, text: r.value, model, variant };
  }

  return { ok: true, text: positional.join(" "), model, variant };
}

function parseRunArgs(rawArgs) {
  // Two distinct call shapes need to coexist:
  //   1. The slash-command wrapper passes "$ARGUMENTS" as ONE quoted token, so
  //      we get e.g. ["--model", "vendor/x", "--task \"fix bug\" --background"].
  //      The last element is a bundled CLI fragment that needs splitArgs.
  //   2. Direct CLI / subagent / test calls pass each arg separately, so we
  //      get e.g. ["--task", "fix bug"]. Here the value "fix bug" must NOT be
  //      split — splitting "fix bug" into ["fix", "bug"] would break parsing.
  // Heuristic: only an arg that BOTH starts with "--" AND contains whitespace
  // is a bundled CLI fragment. A standalone value-arg (e.g. "fix bug") never
  // starts with "--", so it's left intact. A standalone flag (e.g. "--task")
  // never contains whitespace, so it's left intact.
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
      if (v === undefined) return { ok: false, error: "--variant requires a value (provider-specific reasoning effort, e.g. high|max|minimal)" };
      variant = v;
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
      return { ok: false, error: `unknown flag: ${a}. Supported: --task, --task-file, --model, --variant, --yolo, --background, --session-key, --reset, --no-session.` };
    } else if (a.length > 0) {
      return { ok: false, error: `unexpected positional argument: ${a}. Use --task or --task-file.` };
    }
  }
  if (task === null && taskFile === null) {
    return { ok: false, error: "run requires --task <text> or --task-file <path-under-$TMPDIR/opencode-prompts/>" };
  }
  if (task !== null && taskFile !== null) {
    return { ok: false, error: "--task and --task-file are mutually exclusive" };
  }
  if (reset && noSession) {
    return { ok: false, error: "--reset and --no-session are mutually exclusive (reset is destructive; no-session is non-destructive)" };
  }
  if (taskFile !== null) {
    const safeRead = readTaskFileFdBound(taskFile);
    if (!safeRead.ok) return { ok: false, error: safeRead.error };
    task = safeRead.value;
  }
  return { ok: true, value: { task, model, variant, yolo, background, sessionKey, reset, noSession } };
}

function emitTextOnly(text) {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

function emitParsedVerdict(parsed) {
  process.stdout.write(`verdict: ${parsed.verdict}\n`);
  if (parsed.blockers.length > 0) {
    process.stdout.write(`blockers:\n`);
    for (const b of parsed.blockers) process.stdout.write(`  - ${b}\n`);
  } else {
    process.stdout.write(`blockers: (none)\n`);
  }
}

function emitTextWithVerdict(text) {
  emitTextOnly(text);
  process.stdout.write("\n---\n");
  const trailer = extractTrailer(text);
  if (trailer.ok) {
    emitParsedVerdict(trailer.value);
  } else {
    process.stdout.write(`verdict: needs-attention (parse error)\n`);
    process.stdout.write(`parse error: ${trailer.error}\n`);
  }
}

function emitTextWithOptionalVerdict(text) {
  emitTextOnly(text);
  const trailer = extractTrailer(text);
  if (trailer.ok) {
    process.stdout.write("\n---\n");
    emitParsedVerdict(trailer.value);
  }
}

function diffSummary(cwd) {
  try {
    // --no-ext-diff + --no-textconv: defense-in-depth. Plan-006 H1.
    // `--stat` alone bypasses diff.external today, but the flags cost nothing
    // and guard against future git/config combinations.
    const unstaged = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--stat"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Some opencode tasks `git add` files as part of their work. Include the
    // staged diff so the user sees the full set of changes, not just the
    // working tree.
    const staged = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--stat"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let summary = "";
    if (unstaged.trim()) summary += unstaged;
    if (staged.trim()) {
      summary += "\nStaged changes:\n";
      summary += staged;
    }
    if (untracked.trim()) {
      summary += "\nUntracked files:\n";
      for (const line of untracked.trim().split("\n")) summary += `  ${line}\n`;
    }
    return summary || "(no file changes detected)";
  } catch {
    return "(git diff unavailable)";
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidIsOurSupervisor(pid, jobId) {
  if (!isAlive(pid)) return false;
  if (process.platform !== "linux") {
    // R2-4: best-effort on macOS / other.
    return true;
  }
  try {
    // The supervisor sets process.title = "buddy-supervisor:<jobId>". On Linux,
    // process.title overwrites argv (via uv_set_process_title / PR_SET_NAME +
    // argv overwrite), so /proc/<pid>/cmdline shows the title — both the
    // "buddy-supervisor" prefix AND the jobId. Match BOTH substrings to defend
    // against PID reuse: a recycled PID running an unrelated command with the
    // jobId in its argv would NOT also have "buddy-supervisor".
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("buddy-supervisor") && cmdline.includes(jobId);
  } catch {
    return false;
  }
}

function runSetup() {
  const cli = detectOpencode({ env: process.env });
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const cfg = detectConfig({ configPath });
  const lines = [];
  if (cli.installed) {
    lines.push(`✓ opencode is installed (${cli.binary}, ${cli.version})`);
  } else {
    lines.push(`✗ opencode is not installed`);
    lines.push("");
    lines.push(cli.guidance);
  }
  lines.push("");
  if (cfg.ok) {
    lines.push(`✓ default model configured: ${cfg.model} (from ${cfg.configPath})`);
  } else {
    lines.push(`✗ ${cfg.error}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

function runModels() {
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const result = listModels({ configPath });
  if (!result.ok) {
    process.stdout.write(`${result.error}\n`);
    process.exit(0);
  }
  for (const m of result.value) {
    process.stdout.write(`${m}\n`);
  }
  process.exit(0);
}

async function runReview(rawArgs) {
  // Plan-006 Phase 3 (C1) test seam: lets the .catch() at the dispatch
  // site be exercised by tests. Production users never hit this — the
  // env var must exactly match a function name to fire.
  if (process.env.OPENCODE_BUDDY_TEST_THROW === "runReview") {
    throw new Error("OPENCODE_BUDDY_TEST_THROW=runReview simulated failure");
  }
  const parsed = parseReviewArgs(rawArgs);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const args = parsed.value;
  const cwd = process.env.OPENCODE_REPO_ROOT ?? process.cwd();

  const cli = detectOpencode({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`opencode is not installed.\n\n${cli.guidance}\n`);
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

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;
  const opencodeArgs = ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd];
  if (args.model) opencodeArgs.push("--model", args.model);
  if (args.variant) opencodeArgs.push("--variant", args.variant);

  const invocation = await dispatchOpencode({
    binary: cli.binary,
    cwd,
    projectDir,
    // Adversarial style gets its own session-continuity tuple — distinct
    // session history from friendly review under the same plan/branch + model.
    role: args.style === "adversarial" ? "review-adversarial" : "review",
    model: args.model,
    prompt,
    opencodeArgs,
    sessionKeyOverride: args.sessionKey ?? null,
    reset: args.reset ?? false,
    noSession: args.noSession ?? false,
  });

  if (!invocation.ok) {
    process.stdout.write(`opencode invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }

  if (invocation.sessionId) {
    process.stderr.write(
      `opencode session: ${invocation.sessionId} ` +
      `(key=${invocation.sessionKey}; --session-key to override; --reset to start fresh)\n`,
    );
  }
  emitTextWithVerdict(invocation.text);
  process.exit(0);
}

async function runPrompt(rawArgs) {
  // Plan-006 Phase 3 (C1) test seam — see runReview.
  if (process.env.OPENCODE_BUDDY_TEST_THROW === "runPrompt") {
    throw new Error("OPENCODE_BUDDY_TEST_THROW=runPrompt simulated failure");
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
  const cwd = process.env.OPENCODE_REPO_ROOT ?? process.cwd();
  const cli = detectOpencode({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`opencode is not installed.\n\n${cli.guidance}\n`);
    process.exit(0);
  }

  const model = input.model ?? process.env.OPENCODE_MODEL ?? null;
  const variant = input.variant ?? process.env.OPENCODE_VARIANT ?? null;

  const invocation = await invokeOpencode({
    binary: cli.binary,
    prompt: input.text,
    cwd,
    model,
    variant,
  });

  if (!invocation.ok) {
    process.stdout.write(`opencode invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }
  emitTextWithOptionalVerdict(invocation.text);
  process.exit(0);
}

async function runRun(rawArgs) {
  // Plan-006 Phase 3 (C1) test seam — see runReview.
  if (process.env.OPENCODE_BUDDY_TEST_THROW === "runRun") {
    throw new Error("OPENCODE_BUDDY_TEST_THROW=runRun simulated failure");
  }
  const parsed = parseRunArgs(rawArgs);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const args = parsed.value;
  const cwd = process.env.OPENCODE_REPO_ROOT ?? process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;

  const isInteractive = process.stderr.isTTY || process.env.OPENCODE_BUDDY_FORCE_INTERACTIVE === "1";
  if (!args.yolo && !isInteractive && !args.background) {
    process.stderr.write(
      "run requires --yolo when invoked from a non-interactive context (subagent, CI, piped stderr). " +
      "Without --yolo, opencode prompts for write permissions and the call would stall until timeout.\n",
    );
    process.exit(2);
  }
  if (args.background && !args.yolo) {
    process.stderr.write(
      "--background requires --yolo. Background runs cannot answer opencode's write permission prompts.\n",
    );
    process.exit(2);
  }

  const cli = detectOpencode({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`opencode is not installed.\n\n${cli.guidance}\n`);
    process.exit(0);
  }

  if (args.background) {
    return runRunBackground(args, cwd, projectDir, cli);
  }

  const opencodeArgs = ["run", "--format", "json", "--dir", cwd];
  if (args.yolo) opencodeArgs.push("--dangerously-skip-permissions");
  if (args.model) opencodeArgs.push("--model", args.model);
  if (args.variant) opencodeArgs.push("--variant", args.variant);

  // Foreground runs are synchronous — pid:null so /opencode:cancel
  // short-circuits cleanly rather than confusingly checking buddy's own pid.
  const job = createJob(projectDir, {
    kind: "run",
    model: args.model,
    pid: null,
    summary: args.task.split("\n")[0].slice(0, 80),
  });

  const invocation = await dispatchOpencode({
    binary: cli.binary,
    cwd,
    projectDir,
    role: "run",
    model: args.model,
    prompt: args.task,
    opencodeArgs,
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
    process.stdout.write(`opencode invocation failed:\n${invocation.error}\n`);
    process.exit(0);
  }

  updateJob(projectDir, job.id, {
    status: "completed",
    finished_at: new Date().toISOString(),
    exit_code: 0,
  });

  if (invocation.sessionId) {
    process.stderr.write(
      `opencode session: ${invocation.sessionId} ` +
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

  // Session continuity: parent owns pre-flight + lock acquisition before
  // spawning the supervisor. Per round-6 simplified lock design, the lock is
  // pure mkdir-EEXIST. Parent-owned acquisition + supervisor-owned release at
  // close keeps the at-most-one-holder invariant across the parent → supervisor
  // lifecycle.
  const key = currentSessionKey({ cwd, override: args.sessionKey });
  let degraded = false;
  let resumeId = null;
  let lockAcquired = false;

  // --no-session short-circuit (per code-review): a one-off detached run
  // never reads or writes the .session-id file, so the lock isn't needed.
  // Treat as degraded-mode-by-design (no save, no continuity, no lock).
  if (args.noSession) {
    degraded = true; // supervisor will not save and will not release a lock
  } else {
    const lock = acquireSessionLock(projectDir, key, "run", args.model);
    if (!lock.ok) {
      process.stderr.write(
        `warn: another opencode dispatch holds the session lock for ${key}/run/${args.model}; ` +
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

  const opencodeArgs = [
    "run",
    "--print-logs", "--log-level", "INFO",
    "--format", "json",
    "--dangerously-skip-permissions",
    "--dir", cwd,
  ];
  if (args.model) opencodeArgs.push("--model", args.model);
  if (args.variant) opencodeArgs.push("--variant", args.variant);
  if (resumeId !== null) opencodeArgs.push("--session", resumeId);
  opencodeArgs.push(args.task);

  const supervisorPath = join(dirname(fileURLToPath(import.meta.url)), "lib", "supervisor.mjs");

  // Supervisor argv: 5 session-continuity positionals (role, sessionKey,
  // model, noSession, degraded) BEFORE ...opencodeArgs.
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
      ...opencodeArgs,
    ],
    { detached: true, stdio: "ignore" },
  );
  supervisor.unref();

  // Lock-ownership handoff (only if parent acquired the lock — no-op for
  // --no-session and lock-contention degraded modes). Parent releases the
  // lock if spawn() fails synchronously OR fires "error" before "spawn".
  // Otherwise ownership transfers to the supervisor's own crash/close handlers.
  if (lockAcquired) {
    let ownershipTransferred = false;
    supervisor.once("error", (err) => {
      if (ownershipTransferred) return;
      try { rmSync(sessionLockPath(projectDir, key, "run", args.model), { recursive: true, force: true }); } catch {}
      process.stderr.write(`error: failed to spawn supervisor: ${err.message}\n`);
    });
    supervisor.once("spawn", () => {
      ownershipTransferred = true;
    });
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
    process.stdout.write(`Resuming opencode session: ${resumeId} (key=${key})\n`);
  } else if (degraded) {
    process.stdout.write(`Running without session continuity (lock contention).\n`);
  }
  process.stdout.write(`Check status:  /opencode:status ${job.id}\n`);
  process.stdout.write(`Get result:    /opencode:result ${job.id}\n`);
  process.stdout.write(`Cancel:        /opencode:cancel ${job.id}\n`);
  process.exit(0);
}

function elapsedHuman(startIso, finishIso) {
  const start = new Date(startIso).getTime();
  const end = finishIso ? new Date(finishIso).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function runStatus(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const jobId = argv.find((a) => a.startsWith("job_"));

  if (jobId) {
    const r = loadJob(projectDir, jobId);
    if (!r.ok) {
      process.stdout.write(`${r.error}\n`);
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(r.value, null, 2) + "\n");
    process.exit(0);
  }

  const list = listJobs(projectDir);
  if (!list.ok) {
    process.stdout.write(`failed to list jobs: ${list.error}\n`);
    process.exit(0);
  }
  if (list.value.length === 0) {
    process.stdout.write("no jobs found in this repo\n");
    process.exit(0);
  }

  process.stdout.write("| id | kind | model | status | elapsed | summary |\n");
  process.stdout.write("|---|---|---|---|---|---|\n");
  for (const j of list.value) {
    process.stdout.write(
      `| ${j.id} | ${j.kind} | ${j.model ?? "(default)"} | ${j.status} | ${elapsedHuman(j.started_at, j.finished_at)} | ${(j.summary ?? "").slice(0, 60)} |\n`,
    );
  }
  process.exit(0);
}

function runResult(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const jobId = argv.find((a) => a.startsWith("job_"));
  if (!jobId) {
    process.stderr.write("result requires a job id (e.g., result job_abc123)\n");
    process.exit(2);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const r = loadJob(projectDir, jobId);
  if (!r.ok) {
    process.stdout.write(`${r.error}\n`);
    process.exit(0);
  }
  const job = r.value;
  if (job.status === "running") {
    process.stdout.write(`job ${job.id} is still running. Wait or /opencode:cancel ${job.id}.\n`);
    process.exit(0);
  }
  if (job.stdout_path) {
    try {
      const text = readFileSync(job.stdout_path, "utf8");
      process.stdout.write(text);
      if (!text.endsWith("\n")) process.stdout.write("\n");
    } catch {
      process.stdout.write(`(no stdout captured for ${job.id})\n`);
    }
  } else {
    process.stdout.write(`(no stdout captured for ${job.id})\n`);
  }
  process.stdout.write(`\n---\nstatus: ${job.status} (exit ${job.exit_code})\n`);
  process.exit(0);
}

function runCancel(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const jobId = argv.find((a) => a.startsWith("job_"));
  if (!jobId) {
    process.stderr.write("cancel requires a job id (e.g., cancel job_abc123)\n");
    process.exit(2);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const r = loadJob(projectDir, jobId);
  if (!r.ok) {
    process.stdout.write(`${r.error}\n`);
    process.exit(0);
  }
  const job = r.value;
  if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
    process.stdout.write(`job ${job.id} is already ${job.status} — no-op\n`);
    process.exit(0);
  }

  // Foreground jobs record pid: null because they are synchronous in their
  // calling shell — there's no separate process for cancel to signal.
  if (job.pid === null && job.pgid === null) {
    process.stdout.write(
      `cannot cancel foreground job ${job.id}: foreground runs are synchronous ` +
      `and have no supervising process. Interrupt the calling shell directly.\n`,
    );
    process.exit(0);
  }

  // Allow cancel from a session that started AFTER the previous one exited
  // and stamped the job "session-ended". Without this, long-running background
  // jobs that survive a session boundary become uncancelable.
  const upd = updateJob(projectDir, job.id, {
    status: "cancelled",
    finished_at: new Date().toISOString(),
  }, { expectedStatus: ["running", "session-ended"] });
  if (!upd.ok) {
    const after = loadJob(projectDir, job.id);
    process.stdout.write(`job ${job.id} finished before cancel could apply — status: ${after.value?.status}\n`);
    process.exit(0);
  }

  if (!job.pid || !job.pgid) {
    process.stdout.write(`cancelled job ${job.id} (no recorded pid/pgid — was the supervisor not yet running?)\n`);
    process.exit(0);
  }
  if (!pidIsOurSupervisor(job.pid, job.id)) {
    process.stdout.write(
      `cancelled job ${job.id} in state, but pid ${job.pid} is no longer our supervisor ` +
      `(process gone or pid recycled — refusing to send signals).\n`,
    );
    process.exit(0);
  }
  if (process.platform !== "linux") {
    process.stdout.write(
      `WARNING: macOS cancel uses best-effort PID match (no /proc cmdline). ` +
      `If pid ${job.pid} was recycled by an unrelated process since the supervisor ` +
      `started, that unrelated process will receive SIGTERM. macOS-specific ` +
      `verification via 'ps -o command=' is tracked for plan 002.\n`,
    );
  }
  try { process.kill(-job.pgid, "SIGTERM"); } catch {}
  const escalator = spawn(
    process.execPath,
    [
      "-e",
      `
      const fs = require("node:fs");
      const pid = ${job.pid};
      const pgid = ${job.pgid};
      const jobId = ${JSON.stringify(job.id)};
      function alive(p) { try { process.kill(p, 0); return true; } catch { return false; } }
      function ours(p) {
        if (!alive(p)) return false;
        if (process.platform !== "linux") return true;
        try {
          const cmdline = fs.readFileSync("/proc/" + p + "/cmdline", "utf8");
          return cmdline.includes("buddy-supervisor") && cmdline.includes(jobId);
        } catch { return false; }
      }
      setTimeout(() => {
        if (alive(pid) && ours(pid)) {
          try { process.kill(-pgid, "SIGKILL"); } catch {}
        }
      }, 2000);
      `,
    ],
    { detached: true, stdio: "ignore" },
  );
  escalator.unref();
  process.stdout.write(`cancelled job ${job.id} (pgid ${job.pgid}, supervisor pid ${job.pid})\n`);
  process.exit(0);
}

function runGate(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  if (argv.length > 1) {
    process.stderr.write(`gate accepts at most one argument (on|off|status); got: ${argv.join(" ")}\n`);
    process.exit(2);
  }
  const action = (argv[0] ?? "status").toLowerCase();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  if (action === "status") {
    const cfg = loadConfig(projectDir);
    if (!cfg.ok) {
      process.stderr.write(`${cfg.error}\n`);
      process.exit(1);
    }
    process.stdout.write(`Stop-hook review gate: ${cfg.value.stopReviewGate ? "ON" : "OFF"}\n`);
    process.exit(0);
  }

  if (action === "on" || action === "off") {
    const r = updateConfig(projectDir, { stopReviewGate: action === "on" });
    if (!r.ok) {
      process.stderr.write(`${r.error}\n`);
      process.exit(1);
    }
    process.stdout.write(`Stop-hook review gate set to ${action.toUpperCase()}.\n`);
    if (action === "on") {
      process.stdout.write(
        `On the next 'Stop' event (Claude finishes a turn), the gate will run a review of the working-tree state ` +
        `and the assistant's last message. Use '/opencode:gate off' to disable.\n`,
      );
    }
    process.exit(0);
  }

  process.stderr.write(`unknown gate action: ${action}. Use: on, off, status.\n`);
  process.exit(2);
}

const subcommand = process.argv[2];
const rest = process.argv.slice(3);

switch (subcommand) {
  case "setup":
    runSetup();
    break;
  case "models":
    runModels();
    break;
  // Plan-006 Phase 3 (C1): top-level .catch() wrappers eliminate the
  // unhandled-rejection footgun. Currently no path inside these runners
  // throws (errors return {ok:false} + explicit process.exit), but any
  // future refactor that introduces a throw would crash Node ≥15 with
  // exit code 1 from unhandled rejection. The .catch() ensures we exit
  // cleanly with code 2 + a clear error message instead.
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
  case "gate":
    runGate(rest);
    break;
  default:
    process.stderr.write(
      `Unknown subcommand: ${subcommand ?? "(none)"}.\nUsage: buddy <setup|models|review|prompt|run|status|result|cancel|gate> [args...]\n`,
    );
    process.exit(2);
}
