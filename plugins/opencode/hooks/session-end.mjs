#!/usr/bin/env node
// Session-end hook: marks `running` jobs as `session-ended` so the next
// SessionStart can detect them as orphans.
//
// Plan-006 Phase 4 (H4): adopts the same fail-open ESM ordering as
// session-start.mjs and stop-review-gate-hook.mjs. Module-load failures
// exit 0 (fail-open); runtime errors AFTER imports resolve still exit
// with the appropriate non-zero code (e.g., updateJob failure stays at
// exit 1 — that's intentional, not in scope for the fail-open semantics).
import { readFileSync } from "node:fs";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  } catch {}
  return null;
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`session-end: module-load failure (failing open): ${err.message ?? err}\n`);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`session-end: module-load rejection (failing open): ${err && err.message ? err.message : err}\n`);
  process.exit(0);
});

if (process.env.OPENCODE_BUDDY_TEST_THROW === "hookLoad") {
  throw new Error("OPENCODE_BUDDY_TEST_THROW=hookLoad simulated module-load failure");
}

const { listJobs, updateJob } = await import("../scripts/lib/jobs.mjs");

const input = readHookInput();
const projectDir =
  input?.cwd ??
  process.env.CLAUDE_PROJECT_DIR ??
  process.cwd();

const list = listJobs(projectDir);
if (!list.ok) {
  process.stderr.write(`session-end: failed to list jobs: ${list.error}\n`);
  process.exit(1);
}

let errored = false;
for (const j of list.value) {
  if (j.status === "running") {
    // Best-effort serialization. The expectedStatus check reduces the race
    // window but does NOT eliminate it — both supervisor and SessionEnd can
    // read "running", both pass the check, last writer wins. Worst case is a
    // job that completed gets stamped "session-ended"; recoverable via events
    // file. True flock-based serialization is tracked for plan 002.
    const r = updateJob(projectDir, j.id, { status: "session-ended" }, { expectedStatus: "running" });
    if (!r.ok && !/status changed/i.test(r.error)) {
      process.stderr.write(`session-end: failed to update job ${j.id}: ${r.error}\n`);
      errored = true;
    }
  }
}
process.exit(errored ? 1 : 0);
