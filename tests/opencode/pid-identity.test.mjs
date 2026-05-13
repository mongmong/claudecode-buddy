// Plan-006 Phase 5 (C2 + M2). Unit tests for the extracted
// pid-identity helper with injectable {platform, cmdlineReader} so
// Linux CI can verify the macOS branch without a real macOS host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pidIsOurSupervisor } from "../../plugins/opencode/scripts/lib/pid-identity.mjs";

const FAKE_PID = 99999;
const JOB_ID = "job_abc123";

test("linux branch: matches when cmdline contains both 'buddy-supervisor' and jobId", () => {
  const cmdlineReader = () => `node\0buddy-supervisor:${JOB_ID}\0--task\0fix\0`;
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "linux",
    cmdlineReader,
    isAlive: () => true,
  });
  assert.equal(result, true);
});

test("linux branch: rejects when cmdline lacks 'buddy-supervisor' (PID reuse)", () => {
  // Reused PID running an unrelated process with the job-id in argv —
  // matches jobId substring but not buddy-supervisor. Must reject.
  const cmdlineReader = () => `/usr/bin/grep\0${JOB_ID}\0`;
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "linux",
    cmdlineReader,
    isAlive: () => true,
  });
  assert.equal(result, false);
});

test("linux branch: rejects when cmdline lacks jobId (different job's supervisor)", () => {
  const cmdlineReader = () => `node\0buddy-supervisor:job_DIFFERENT\0`;
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "linux",
    cmdlineReader,
    isAlive: () => true,
  });
  assert.equal(result, false);
});

test("linux branch: rejects when cmdlineReader throws (ENOENT — process exited)", () => {
  const cmdlineReader = () => { throw new Error("ENOENT"); };
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "linux",
    cmdlineReader,
    isAlive: () => true,
  });
  assert.equal(result, false);
});

test("darwin branch: matches via ps output", () => {
  // ps -o command= -p <pid> on macOS returns the full argv joined by spaces.
  const cmdlineReader = () => `node /path/to/supervisor.mjs job_abc123 /project /opencode /cwd run plan-005 vendor/x false false run --task fix buddy-supervisor:${JOB_ID}\n`;
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "darwin",
    cmdlineReader,
    isAlive: () => true,
  });
  assert.equal(result, true);
});

test("darwin branch: rejects when ps output lacks 'buddy-supervisor' (PID reuse)", () => {
  // The macOS PID-reuse RCE scenario — DeepSeek's audit C2. Without the
  // cmdline check, the old code returned `true` unconditionally on macOS.
  const cmdlineReader = () => `node /usr/local/bin/some-build-tool ${JOB_ID}\n`;
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "darwin",
    cmdlineReader,
    isAlive: () => true,
  });
  assert.equal(result, false);
});

test("darwin branch: rejects when ps fails (process exited / EPERM)", () => {
  const cmdlineReader = () => { throw new Error("ps failed"); };
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "darwin",
    cmdlineReader,
    isAlive: () => true,
  });
  assert.equal(result, false);
});

test("any platform: rejects immediately when pid is not alive (no cmdline read)", () => {
  let cmdlineReaderCalled = false;
  const cmdlineReader = () => { cmdlineReaderCalled = true; return ""; };
  const result = pidIsOurSupervisor(FAKE_PID, JOB_ID, {
    platform: "linux",
    cmdlineReader,
    isAlive: () => false,
  });
  assert.equal(result, false);
  assert.equal(cmdlineReaderCalled, false, "should short-circuit before reading cmdline");
});

test("any platform: rejects when pid is 0 or null (no cmdline read)", () => {
  let cmdlineReaderCalled = false;
  const cmdlineReader = () => { cmdlineReaderCalled = true; return ""; };
  // pid=0 is process group; pid=null is uninitialized. Both should reject.
  assert.equal(pidIsOurSupervisor(0, JOB_ID, { platform: "linux", cmdlineReader }), false);
  assert.equal(pidIsOurSupervisor(null, JOB_ID, { platform: "linux", cmdlineReader }), false);
  assert.equal(cmdlineReaderCalled, false);
});
