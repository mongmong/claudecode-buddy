#!/usr/bin/env node
// Plan-007 Phase 2 dispatcher for the codex plugin.
//
// Carries plan-006 forward from day 1:
//   - Phase 3 (C1): top-level .catch() on async dispatches.
//   - Phase 1 (H1): --no-ext-diff on all git diff calls (in lib/scope.mjs).
//   - Phase 2 (H2 + M1): fd-bound prompt-file via lib/fd-bound.mjs + openFdBound.
//   - Test seams: CODEX_BUDDY_TEST_THROW, CODEX_BUDDY_TEST_PID_NEVER_OURS,
//     CODEX_BUDDY_TEST_SLOW_IMPORT_MS — used by tests; never activate in prod.
//
// Subcommands shipped in Phase 2: setup, review, prompt, models.
// Phase 3+ will add: run, status, result, cancel, gate.
import { execFileSync } from "node:child_process";
import { closeSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openFdBound } from "./lib/fd-bound.mjs";
import { detectCodex } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";
import { resolveScope, getDiff } from "./lib/scope.mjs";
import { buildReviewPrompt } from "./lib/prompt.mjs";
import { invokeCodex } from "./lib/invoke.mjs";
import { extractTrailer } from "./lib/trailer.mjs";
import { splitArgs } from "./lib/args.mjs";
import { listModels } from "./lib/list-models.mjs";

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
  default:
    if (subcommand === undefined) {
      process.stderr.write("usage: codex-buddy <subcommand> [args...]\n\nSubcommands (Phase 2): setup, models, review, prompt\nSubcommands (Phase 3+): run, status, result, cancel, gate\n");
    } else {
      process.stderr.write(`unknown subcommand: ${subcommand}\n\nUse one of: setup, models, review, prompt\n`);
    }
    process.exit(2);
}
