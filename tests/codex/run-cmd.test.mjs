// Plan-007 Phase 3 tests for /codex:run + run --background + status/result/cancel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { createJob, loadJob, updateJob } from "../../plugins/codex/scripts/lib/jobs.mjs";

const SUCCESS_BIN = resolve("tests/codex/fixtures/mock-codex-success.mjs");

function setupRepo(dir) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "init"], { cwd: dir });
}

test("run rejects when neither --task nor --task-file is given", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run"],
      { CODEX_BIN: SUCCESS_BIN, CODEX_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, CODEX_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /requires --task .* or --task-file/i);
  } finally {
    cleanup();
  }
});

test("run rejects --task and --task-file together", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "x", "--task-file", "/tmp/foo"],
      { CODEX_BIN: SUCCESS_BIN, CODEX_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, CODEX_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /mutually exclusive/i);
  } finally {
    cleanup();
  }
});

test("run --sandbox rejects invalid value with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "x", "--sandbox", "yolo-mode"],
      { CODEX_BIN: SUCCESS_BIN, CODEX_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, CODEX_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--sandbox.*read-only.*workspace-write.*danger-full-access/);
  } finally {
    cleanup();
  }
});

test("run foreground with --task succeeds (sandbox read-only default)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "f.txt"), "x\n");
    const result = await runCompanion(
      ["run", "--task", "do nothing", "--no-session"],
      { CODEX_BIN: SUCCESS_BIN, CODEX_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, CODEX_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Looks fine/);
    assert.match(result.stdout, /Files changed:/);
  } finally {
    cleanup();
  }
});

test("run --task-file containment check is path-based (rejects paths outside allowed dir)", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const sneakyPath = join(tmpdir, "sneaky.txt");
    writeFileSync(sneakyPath, "would leak");
    const { dir: repoDir, cleanup: repoCleanup } = makeTempRepo();
    try {
      setupRepo(repoDir);
      const result = await runCompanion(
        ["run", "--task-file", sneakyPath],
        { CODEX_BIN: SUCCESS_BIN, CODEX_REPO_ROOT: repoDir, CLAUDE_PROJECT_DIR: repoDir, TMPDIR: tmpdir, CODEX_BUDDY_FORCE_INTERACTIVE: "1" },
      );
      assert.equal(result.code, 2);
      assert.match(result.stderr, /path .* is not under the allowed prompt directory/i);
      // Path-based message; not the fd-bound "resolves to" message.
      assert.doesNotMatch(result.stderr, /resolves to/i);
    } finally {
      repoCleanup();
    }
  } finally {
    cleanup();
  }
});

test("status reports (no codex jobs) when none exist", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["status"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no codex jobs/);
  } finally {
    cleanup();
  }
});

test("status lists existing jobs with status + elapsed", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "gpt-5", pid: 1, summary: "test-job" });
    updateJob(dir, job.id, { status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });
    const result = await runCompanion(["status"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(job.id));
    assert.match(result.stdout, /completed/);
    assert.match(result.stdout, /test-job/);
  } finally {
    cleanup();
  }
});

test("result requires a job id (exit 2 without one)", async () => {
  const result = await runCompanion(["result"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /requires a job id/);
});

test("result reports header for an existing job", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "gpt-5", pid: 1, summary: "x" });
    updateJob(dir, job.id, { status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });
    const result = await runCompanion(["result", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(job.id));
    assert.match(result.stdout, /status=completed/);
  } finally {
    cleanup();
  }
});

test("cancel <unknown-id> prints a clear error", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["cancel", "job_nonexistent_xxx"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /not found/i);
  } finally {
    cleanup();
  }
});

test("cancel <already-completed-id> is a no-op", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "gpt-5", pid: 1, summary: "done" });
    updateJob(dir, job.id, { status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });
    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /already completed/);
  } finally {
    cleanup();
  }
});

test("cancel of foreground job (pid:null) refuses with a clear message", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "gpt-5", pid: null, summary: "fg" });
    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /cannot cancel foreground job/);
  } finally {
    cleanup();
  }
});

test("cancel of live-but-non-supervisor PID marks cancelled without signaling (CODEX_BUDDY_TEST_PID_NEVER_OURS=1)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    // Use this node process's pid as the "live but not our supervisor" target.
    const job = createJob(dir, { kind: "run", model: "gpt-5", pid: process.pid, pgid: process.pid, summary: "pid-reuse" });
    const result = await runCompanion(
      ["cancel", job.id],
      { CLAUDE_PROJECT_DIR: dir, CODEX_BUDDY_TEST_PID_NEVER_OURS: "1" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no longer our supervisor|recycled|marked cancelled/i);
    // Our process is still alive (cancel did not SIGTERM us).
    assert.equal(process.killed ?? false, false);
  } finally {
    cleanup();
  }
});
