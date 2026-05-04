import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { listJobs } from "../../plugins/opencode/scripts/lib/jobs.mjs";

const RUN_OK_BIN = resolve("tests/opencode/fixtures/mock-opencode-run-success.mjs");
const RUN_EDITS_BIN = resolve("tests/opencode/fixtures/mock-opencode-run-with-edits.mjs");
const RUN_FAIL_BIN = resolve("tests/opencode/fixtures/mock-opencode-run-fail.mjs");

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function setupRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "init", "-q");
}

test("run with --task forwards prompt to opencode and prints output verbatim", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "Investigate why the bug appears intermittent."],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Done\. No code changes/);
  } finally {
    cleanup();
  }
});

test("run prints a Files changed: summary when opencode edits files", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "Create fixed.js with the corrected add function."],
      { OPENCODE_BIN: RUN_EDITS_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Created `fixed\.js`/);
    assert.match(result.stdout, /Files changed:/i);
    assert.match(result.stdout, /fixed\.js/);
    assert.ok(existsSync(join(dir, "fixed.js")));
  } finally {
    cleanup();
  }
});

test("run with --yolo passes --dangerously-skip-permissions to opencode", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--yolo", "--task", "Just say done."],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 0);
  } finally {
    cleanup();
  }
});

test("run rejects --task with no value (trailing flag) with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--task requires a value/i);
  } finally {
    cleanup();
  }
});

test("run rejects empty --task and --task-file together", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /requires --task .* or --task-file/i);
  } finally {
    cleanup();
  }
});

test("run --task-file reads from disk under the allowed dir (subagent route)", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const promptDir = join(tmpdir, "opencode-prompts");
    mkdirSync(promptDir, { recursive: true });
    const taskPath = join(promptDir, "task.txt");
    writeFileSync(taskPath, 'Tricky body with $VAR backticks `whoami` and "quotes".\n');

    const { dir: repoDir, cleanup: repoCleanup } = makeTempRepo();
    try {
      setupRepo(repoDir);
      const result = await runCompanion(
        ["run", "--task-file", taskPath],
        {
          OPENCODE_BIN: RUN_OK_BIN,
          OPENCODE_REPO_ROOT: repoDir,
          CLAUDE_PROJECT_DIR: repoDir,
          TMPDIR: tmpdir,
          OPENCODE_BUDDY_FORCE_INTERACTIVE: "1",
        },
      );
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Done\./);
    } finally {
      repoCleanup();
    }
  } finally {
    cleanup();
  }
});

test("run --task-file rejects paths OUTSIDE the allowed dir", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const sneakyPath = join(tmpdir, "sneaky.txt");
    writeFileSync(sneakyPath, "would leak");
    const { dir: repoDir, cleanup: repoCleanup } = makeTempRepo();
    try {
      setupRepo(repoDir);
      const result = await runCompanion(
        ["run", "--task-file", sneakyPath],
        { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: repoDir, CLAUDE_PROJECT_DIR: repoDir, TMPDIR: tmpdir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /not under the allowed/i);
    } finally {
      repoCleanup();
    }
  } finally {
    cleanup();
  }
});

test("run refuses without --yolo in non-interactive context", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "Just say done."],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /requires --yolo when invoked from a non-interactive/i);
  } finally {
    cleanup();
  }
});

test("run --background requires --yolo even when interactive", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--background", "--task", "Just say done."],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--background requires --yolo/i);
  } finally {
    cleanup();
  }
});

test("run records a foreground job in jobs/ with status completed", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    await runCompanion(
      ["run", "--task", "Just say done.", "--model", "vendor/x"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    const list = listJobs(dir);
    assert.equal(list.ok, true);
    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].kind, "run");
    assert.equal(list.value[0].model, "vendor/x");
    assert.equal(list.value[0].status, "completed");
    assert.equal(list.value[0].exit_code, 0);
    assert.notEqual(list.value[0].finished_at, null);
  } finally {
    cleanup();
  }
});

test("run --background returns immediately with the job-id and supervisor pid", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const start = Date.now();
    const result = await runCompanion(
      ["run", "--background", "--yolo", "--task", "Just say done.", "--model", "vendor/x"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    const elapsed = Date.now() - start;
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Started job (job_[a-z0-9_]+) in the background \(pid \d+\)/);
    assert.ok(elapsed < 2000, `--background returned in ${elapsed} ms; expected < 2000`);
    const list = listJobs(dir);
    assert.equal(list.ok, true);
    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].kind, "run");
    assert.equal(list.value[0].model, "vendor/x");
    assert.ok(list.value[0].pid > 0);
    assert.equal(list.value[0].pid, list.value[0].pgid);
    await new Promise((r) => setTimeout(r, 2000));
    const final = listJobs(dir);
    assert.equal(final.value[0].status, "completed");
    assert.equal(final.value[0].exit_code, 0);
  } finally {
    cleanup();
  }
});

test("run --background captures parsed assistant text (not raw NDJSON)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--background", "--yolo", "--task", "Just say done."],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 0);
    const jobId = result.stdout.match(/Started job (job_[a-z0-9_]+)/)[1];
    await new Promise((r) => setTimeout(r, 2000));
    const stdoutFile = join(dir, ".claudecode-buddy/opencode/jobs", `${jobId}.stdout`);
    assert.ok(existsSync(stdoutFile));
    const content = readFileSync(stdoutFile, "utf8");
    assert.match(content, /Done\. No code changes/);
    assert.doesNotMatch(content, /"type":"text"/);
    const eventsFile = join(dir, ".claudecode-buddy/opencode/jobs", `${jobId}.events`);
    assert.ok(existsSync(eventsFile));
    const events = readFileSync(eventsFile, "utf8");
    assert.match(events, /"type":"text"/);
  } finally {
    cleanup();
  }
});

test("run accepts a bundled --task token from the slash-command wrapper", async () => {
  // Reproduces the codex P2 finding: when /opencode:run injects --model and
  // bash passes "$ARGUMENTS" as one quoted token, the bundled `--task "..."`
  // token must be split and parsed correctly.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--model", "vendor/x", '--task "Just say done."'],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Done\. No code changes/);
  } finally {
    cleanup();
  }
});

test("run preserves --task values containing whitespace when args are pre-split", async () => {
  // Inverse of the bundled-token test: when the caller (subagent / direct
  // CLI) already split argv, "Just say done." must NOT be split again.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "Just say done.", "--yolo"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Done\. No code changes/);
  } finally {
    cleanup();
  }
});

test("run rejects duplicate --model with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--model", "vendor/x", "--model", "vendor/y", "--task", "x", "--yolo"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /duplicate flag: --model/i);
  } finally {
    cleanup();
  }
});

test("run rejects duplicate --task with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "first", "--task", "second", "--yolo"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /duplicate flag: --task/i);
  } finally {
    cleanup();
  }
});

test("run records foreground job with pid: null (not buddy's own pid)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    await runCompanion(
      ["run", "--task", "Just say done.", "--model", "vendor/x"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    const list = listJobs(dir);
    assert.equal(list.value[0].pid, null,
      `foreground jobs must record pid: null so /opencode:cancel short-circuits cleanly; ` +
      `got ${list.value[0].pid}`);
  } finally {
    cleanup();
  }
});

test("run --background captures the REAL exit_code (not always 0)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--background", "--yolo", "--task", "fail please"],
      { OPENCODE_BIN: RUN_FAIL_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 0);
    const jobId = result.stdout.match(/Started job (job_[a-z0-9_]+)/)[1];
    await new Promise((r) => setTimeout(r, 2000));
    const job = listJobs(dir).value.find((j) => j.id === jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.exit_code, 7);
  } finally {
    cleanup();
  }
});
