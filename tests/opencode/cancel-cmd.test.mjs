import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { createJob, loadJob, updateJob } from "../../plugins/opencode/scripts/lib/jobs.mjs";
import { sessionLockPath } from "../../plugins/opencode/scripts/lib/sessions.mjs";

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

// Plan-006 Phase 5a (H3): cancel of a live supervisor RELEASES the session lock.
// Pre-Phase-5, supervisor had no SIGTERM handler — runCancel sent SIGTERM and the
// supervisor exited without releasing the lock dir, so every cancelled background
// job blocked future dispatches for the same (key, role, model) tuple until manual
// `rm -rf`. The new SIGTERM handler in supervisor.mjs releases the lock + updates
// the job before exiting.
//
// Test design: spawn the real supervisor.mjs with mock-opencode-sleep so it keeps
// running. Manually pre-create the lock dir (mimicking what the parent dispatcher
// does in runRunBackground). Wait for supervisor to settle past dynamic imports
// (so we exercise the post-import branch of the SIGTERM handler). Cancel via
// runCompanion. Verify the lock dir no longer exists.
test("cancel of a live supervisor RELEASES the session lock (H3)", async () => {
  const SUPERVISOR = resolve("plugins/opencode/scripts/lib/supervisor.mjs");
  const SLEEP_BIN = resolve("tests/opencode/fixtures/mock-opencode-sleep.mjs");
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", summary: "lock-release-test" });
    const sessionKey = "test-session";
    const role = "run";
    const model = "vendor/x";

    // Pre-create the lock dir as the parent dispatcher does in production.
    const lockPath = sessionLockPath(dir, sessionKey, role, model);
    mkdirSync(lockPath, { recursive: true });
    assert.equal(existsSync(lockPath), true, "test setup: lock dir should exist before cancel");

    // Spawn the REAL supervisor with arguments matching the parent's spawn shape.
    // 9 positional args before ...opencodeArgs: jobId projectDir binary cwd role
    // sessionKey model noSession degraded.
    const supervisor = spawn(
      process.execPath,
      [
        SUPERVISOR,
        job.id, dir, SLEEP_BIN, dir,
        role, sessionKey, model,
        "false", "false",  // noSession, degraded
        "run", "--prompt", "anything",  // opencodeArgs
      ],
      { detached: true, stdio: "ignore" },
    );
    supervisor.unref();
    updateJob(dir, job.id, { pid: supervisor.pid, pgid: supervisor.pid });

    // Wait for supervisor's dynamic imports to complete + opencode child to spawn
    // (~100-200ms typical). This exercises the POST-import branch of the SIGTERM
    // handler (uses real releaseLock).
    await new Promise((r) => setTimeout(r, 500));

    const result = await runCompanion(["cancel", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0, `cancel failed: stderr=${result.stderr}`);

    // Wait for SIGTERM handler to complete its cleanup.
    await new Promise((r) => setTimeout(r, 500));

    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "cancelled");

    assert.equal(existsSync(lockPath), false,
      `expected lock dir ${lockPath} to be released by the supervisor's SIGTERM handler; ` +
      "before Plan-006 Phase 5a, the lock would persist and block future dispatches.");
  } finally {
    cleanup();
  }
});

// Plan-006 Phase 5a (round-2 N1): SIGTERM in the pre-import window must
// also release the lock — the inline-fallback branch of the two-layer
// handler. Without this, a SIGTERM arriving during the supervisor's
// ~5-50ms dynamic-import resolution would kill the supervisor without
// running any cleanup, stranding the lock.
//
// Test design: OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS=400 forces a 400ms delay
// before dynamic imports complete. We send SIGTERM at t=100ms (well within
// the slow-import window) and verify the lock dir is released via the
// inline-fallback branch.
test("supervisor SIGTERM in the pre-import window still releases the lock (N1 inline-fallback)", async () => {
  const SUPERVISOR = resolve("plugins/opencode/scripts/lib/supervisor.mjs");
  const SLEEP_BIN = resolve("tests/opencode/fixtures/mock-opencode-sleep.mjs");
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", summary: "pre-import-sigterm" });
    const sessionKey = "test-session";
    const role = "run";
    const model = "vendor/x";

    const lockPath = sessionLockPath(dir, sessionKey, role, model);
    mkdirSync(lockPath, { recursive: true });
    assert.equal(existsSync(lockPath), true);

    const supervisor = spawn(
      process.execPath,
      [
        SUPERVISOR,
        job.id, dir, SLEEP_BIN, dir,
        role, sessionKey, model,
        "false", "false",
        "run", "--prompt", "anything",
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS: "400" },
      },
    );
    supervisor.unref();

    // Wait 100ms — supervisor is still in its slow-import window.
    await new Promise((r) => setTimeout(r, 100));

    // Send SIGTERM directly (bypass /opencode:cancel since the job's pid
    // wasn't updated yet — the parent normally does this, but in this test
    // we're driving the supervisor directly to exercise the timing).
    try { process.kill(supervisor.pid, "SIGTERM"); } catch {}

    // Wait for inline-fallback cleanup + exit.
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(existsSync(lockPath), false,
      `lock dir should be released by the pre-import SIGTERM handler's inline-fallback branch`);

    // Job record should be cancelled by the inline atomic-write fallback.
    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "cancelled");
    assert.equal(after.value.exit_code, 143);
  } finally {
    cleanup();
  }
});

// Plan-006 Phase 5b (C2): macOS PID-reuse defense. With OPENCODE_BUDDY_TEST_PID_NEVER_OURS=1,
// pidIsOurSupervisor returns false regardless of platform, simulating the
// scenario where the recorded PID is no longer running our supervisor (e.g.,
// recycled to an unrelated process). Cancel must NOT SIGTERM the wrong PID;
// it should print the existing "not our supervisor" branch behavior and just
// mark the job as cancelled in the record.
test("cancel of a live but non-supervisor PID refuses to signal (PID-reuse defense, C2)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    // Use a live PID (this Node process) but force pidIsOurSupervisor → false.
    const job = createJob(dir, { kind: "run", model: "vendor/x", pid: process.pid, pgid: process.pid, summary: "pid-reuse" });
    const result = await runCompanion(
      ["cancel", job.id],
      { CLAUDE_PROJECT_DIR: dir, OPENCODE_BUDDY_TEST_PID_NEVER_OURS: "1" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no longer our supervisor|reused|recycled/i,
      `expected cancel to detect the non-supervisor PID; stdout: ${result.stdout}`);
    // Our process is still alive (cancel did not SIGTERM us).
    assert.equal(process.killed ?? false, false);
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
