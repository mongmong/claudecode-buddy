#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectOpencode } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";
import { resolveScope, getDiff } from "./lib/scope.mjs";
import { buildReviewPrompt } from "./lib/prompt.mjs";
import { invokeOpencode, invokeOpencodeRaw } from "./lib/invoke.mjs";
import { extractTrailer } from "./lib/trailer.mjs";
import { splitArgs } from "./lib/args.mjs";
import { listModels } from "./lib/list-models.mjs";
import { createJob, updateJob, listJobs, loadJob, jobsDir, jobPath, JOB_ID_RE } from "./lib/jobs.mjs";

const VALID_SCOPES = new Set(["auto", "working-tree", "branch"]);

function parseReviewArgs(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const out = { scope: "auto", base: "main", model: null };
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
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --scope, --base, --model.` };
    } else if (a.length > 0) {
      return { ok: false, error: `unexpected positional argument: ${a}. The review subcommand only accepts flag-style arguments.` };
    }
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

function readTaskFileFdBound(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    return { ok: false, error: `failed to open task file ${path}: ${err.message}` };
  }
  try {
    let realPath;
    try {
      realPath = realpathSync(`/proc/self/fd/${fd}`);
    } catch (err) {
      return {
        ok: false,
        error:
          `could not resolve fd path for ${path} (Linux /proc required): ${err.message}. ` +
          `If on macOS, this defense is not yet implemented — plan 002 adds platform-specific support.`,
      };
    }
    const base = allowedPromptDir();
    if (realPath !== base && !realPath.startsWith(base + "/")) {
      return {
        ok: false,
        error:
          `--task-file path \`${path}\` resolves to \`${realPath}\` which is not under the allowed prompt directory ` +
          `(${base}). The subagent must write task files via mktemp inside $TMPDIR/opencode-prompts/.`,
      };
    }
    return { ok: true, value: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
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
      if (promptFile === undefined) return { ok: false, error: "--prompt-file requires a path argument" };
    } else if (a === "--model") {
      model = argv[++i];
      if (model === undefined) return { ok: false, error: "--model requires a provider/model argument" };
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

function parseRunArgs(rawArgs) {
  // Don't flatMap-splitArgs here: --task values are free-form text that may
  // contain whitespace, and splitting "say done" into ["say", "done"] would
  // break parsing. Bash passes the task value as a single arg already.
  // Single-arg quoted-bundle form is supported via splitArgs only when the
  // entire rawArgs is one element (rare for run; common for review).
  const argv = rawArgs.length === 1 ? splitArgs(rawArgs[0]) : rawArgs;
  let task = null;
  let taskFile = null;
  let model = null;
  let yolo = false;
  let background = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--task requires a value" };
      task = v;
    } else if (a === "--task-file") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--task-file requires a path argument" };
      taskFile = v;
    } else if (a === "--model") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--model requires a value" };
      model = v;
    } else if (a === "--yolo") {
      yolo = true;
    } else if (a === "--background") {
      background = true;
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --task, --task-file, --model, --yolo, --background.` };
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
  if (taskFile !== null) {
    const safeRead = readTaskFileFdBound(taskFile);
    if (!safeRead.ok) return { ok: false, error: safeRead.error };
    task = safeRead.value;
  }
  return { ok: true, value: { task, model, yolo, background } };
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
    const out = execFileSync("git", ["diff", "--stat"], {
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
    if (out.trim()) summary += out;
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
    return true;
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("supervisor.mjs") && cmdline.includes(jobId);
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

async function runRun(rawArgs) {
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
  opencodeArgs.push(args.task);

  const job = createJob(projectDir, {
    kind: "run",
    model: args.model,
    pid: process.pid,
    summary: args.task.split("\n")[0].slice(0, 80),
  });

  const invocation = await invokeOpencodeRaw({
    binary: cli.binary,
    args: opencodeArgs,
    cwd,
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

  const opencodeArgs = [
    "run",
    "--print-logs", "--log-level", "INFO",
    "--format", "json",
    "--dangerously-skip-permissions",
    "--dir", cwd,
  ];
  if (args.model) opencodeArgs.push("--model", args.model);
  opencodeArgs.push(args.task);

  const supervisorPath = join(dirname(fileURLToPath(import.meta.url)), "lib", "supervisor.mjs");

  const supervisor = spawn(
    process.execPath,
    [supervisorPath, job.id, projectDir, cli.binary, cwd, ...opencodeArgs],
    { detached: true, stdio: "ignore" },
  );
  supervisor.unref();

  updateJob(projectDir, job.id, {
    pid: supervisor.pid,
    pgid: supervisor.pid,
    stdout_path: join(jobsDir(projectDir), `${job.id}.stdout`),
    stderr_path: join(jobsDir(projectDir), `${job.id}.stderr`),
    events_path: join(jobsDir(projectDir), `${job.id}.events`),
  });

  process.stdout.write(`Started job ${job.id} in the background (pid ${supervisor.pid}).\n`);
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

  const upd = updateJob(projectDir, job.id, {
    status: "cancelled",
    finished_at: new Date().toISOString(),
  }, { expectedStatus: "running" });
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
          return cmdline.includes("supervisor.mjs") && cmdline.includes(jobId);
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
  case "run":
    runRun(rest);
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
    process.stderr.write(
      `Unknown subcommand: ${subcommand ?? "(none)"}.\nUsage: buddy <setup|models|review|prompt|run|status|result|cancel> [args...]\n`,
    );
    process.exit(2);
}
