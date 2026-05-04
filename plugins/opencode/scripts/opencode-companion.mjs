#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { detectOpencode } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";
import { resolveScope, getDiff } from "./lib/scope.mjs";
import { buildReviewPrompt } from "./lib/prompt.mjs";
import { invokeOpencode } from "./lib/invoke.mjs";
import { extractTrailer } from "./lib/trailer.mjs";
import { splitArgs } from "./lib/args.mjs";
import { listModels } from "./lib/list-models.mjs";

function parseReviewArgs(rawArgs) {
  // Flatten: each rawArg may itself be a quoted multi-token string from the
  // slash-command's bash interpolation. splitArgs is idempotent on already-split
  // single tokens, so flatMap over every rawArg handles all three call shapes:
  //   ["--scope", "auto"]                    (multi-arg, already split)
  //   ["--scope auto"]                       (single quoted string)
  //   ["--model", "X", "--scope auto"]       (mixed: injected model + quoted $ARGUMENTS)
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const out = { scope: "auto", base: "main", model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") out.scope = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --scope, --base, --model.` };
    } else if (a.length > 0) {
      return { ok: false, error: `unexpected positional argument: ${a}. The review subcommand only accepts flag-style arguments.` };
    }
  }
  return { ok: true, value: out };
}

function allowedPromptDir() {
  const tmp = process.env.TMPDIR || "/tmp";
  try {
    const resolver = realpathSync.native ?? realpathSync;
    return resolver(tmp) + "/opencode-prompts";
  } catch {
    return "/tmp/opencode-prompts";
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

function parsePromptArgs(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  let promptFile = null;
  let model = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt-file") {
      promptFile = argv[++i];
      if (!promptFile) return { ok: false, error: "--prompt-file requires a path argument" };
    } else if (a === "--model") {
      model = argv[++i];
      if (!model) return { ok: false, error: "--model requires a provider/model argument" };
    } else if (a === "--stdin") {
      return {
        ok: false,
        error:
          "--stdin is not supported in plan 000 (deferred for security review). " +
          "Use --prompt-file <path-under-$TMPDIR/opencode-prompts/> instead.",
      };
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --prompt-file, --model.` };
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
    try {
      return { ok: true, text: readFileSync(promptFile, "utf8"), model };
    } catch (err) {
      return { ok: false, error: `failed to read prompt file ${promptFile}: ${err.message}` };
    }
  }

  return { ok: true, text: positional.join(" "), model };
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
  });

  const invocation = await invokeOpencode({
    binary: cli.binary,
    prompt,
    cwd,
    model: args.model,
  });

  if (!invocation.ok) {
    process.stdout.write(`opencode invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }

  emitTextWithVerdict(invocation.text);
  process.exit(0);
}

async function runPrompt(rawArgs) {
  const input = parsePromptArgs(rawArgs);
  if (!input.ok) {
    process.stderr.write(`${input.error}\n`);
    process.exit(2);
  }
  // Trim only for the empty-check; pass the original verbatim text to opencode
  // so leading/trailing whitespace in the orchestrator's prompt is preserved.
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

  // Model precedence: --model flag > OPENCODE_MODEL env > opencode config default.
  const model = input.model ?? process.env.OPENCODE_MODEL ?? null;

  const invocation = await invokeOpencode({
    binary: cli.binary,
    prompt: input.text,
    cwd,
    model,
  });

  if (!invocation.ok) {
    process.stdout.write(`opencode invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }
  emitTextWithOptionalVerdict(invocation.text);
  process.exit(0);
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
  case "review":
    runReview(rest);
    break;
  case "prompt":
    runPrompt(rest);
    break;
  default:
    process.stderr.write(
      `Unknown subcommand: ${subcommand ?? "(none)"}.\nUsage: opencode-companion <setup|models|review|prompt> [args...]\n`,
    );
    process.exit(2);
}
