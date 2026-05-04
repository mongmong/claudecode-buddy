import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { createJob, loadJob, updateJob } from "../../plugins/opencode/scripts/lib/jobs.mjs";

test("cancel <job-id> with no live pid marks the job as cancelled", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", pid: 2147483647, pgid: 2147483647, summary: "abandoned" });
    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /cancelled|no longer our supervisor/i);
    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "cancelled");
  } finally {
    cleanup();
  }
});

test("cancel <job-id> with a live supervisor sends SIGTERM (verified via cmdline)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", summary: "live" });
    const supervisorMock = resolve("tests/opencode/fixtures/mock-supervisor.mjs");
    const child = spawn(process.execPath, [supervisorMock, job.id], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    updateJob(dir, job.id, { pid: child.pid, pgid: child.pid });
    await new Promise((r) => setTimeout(r, 200));
    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /cancelled/i);
    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "cancelled");
    await new Promise((r) => setTimeout(r, 500));
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, false, `supervisor pid ${child.pid} still alive after cancel`);
  } finally {
    cleanup();
  }
});

test("cancel <unknown-id> prints a clear error", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["cancel", "job_nonexistent"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /not found/i);
  } finally {
    cleanup();
  }
});

test("cancel <already-completed-id> is a no-op (no error)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", pid: 1, summary: "done" });
    updateJob(dir, job.id, { status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });
    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /already completed|no-op/i);
  } finally {
    cleanup();
  }
});

test("cancel refuses to signal a live PID that is NOT our supervisor", async () => {
  // PID-reuse defense: a live process whose /proc/<pid>/cmdline doesn't
  // contain `buddy-supervisor` must NOT receive SIGTERM. We spawn a plain
  // `sleep` (with no buddy-supervisor in argv or process.title), record its
  // pid in a job, run cancel, and verify the sleep is still alive afterwards.
  const { dir, cleanup } = makeTempRepo();
  let sleeper;
  try {
    sleeper = spawn("/bin/sh", ["-c", "exec sleep 30"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    await new Promise((r) => setTimeout(r, 100));
    const job = createJob(dir, { kind: "run", model: "vendor/x", pid: sleeper.pid, pgid: sleeper.pid, summary: "imposter" });

    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no longer our supervisor|refusing to send signals/i);

    let alive = true;
    try { process.kill(sleeper.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, `cancel must NOT signal a non-supervisor pid (pid ${sleeper.pid} should still be alive)`);

    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "cancelled");
  } finally {
    if (sleeper && sleeper.pid) { try { process.kill(sleeper.pid, "SIGTERM"); } catch {} }
    cleanup();
  }
});

test("cancel refuses foreground jobs (pid:null) with a clear message", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", pid: null, pgid: null, summary: "fg" });
    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /cannot cancel foreground job/i);
    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "running",
      "cancelling a foreground job must NOT change its status — the synchronous shell owns it");
  } finally {
    cleanup();
  }
});

test("cancel works on a job whose status is session-ended (survived a session boundary)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", pid: 2147483647, pgid: 2147483647, summary: "survivor" });
    updateJob(dir, job.id, { status: "session-ended" });
    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "cancelled",
      "session-ended jobs must be cancellable from a later session — otherwise long-running " +
      "background jobs that outlive their session become permanently uncancelable");
  } finally {
    cleanup();
  }
});
