#!/usr/bin/env node
// Session-end hook: marks `running` codex jobs as `session-ended` so the next
// SessionStart can detect them as orphans.
//
// Plan-007 Phase 1 (carries plan-006 Phase 4 H4 forward from day 1): same
// fail-open ESM ordering as session-start.mjs and stop-review-gate-hook.mjs.
// Module-load failures exit 0; runtime errors AFTER imports resolve still
// exit with the appropriate non-zero code (e.g., updateJob failure stays
// at exit 1 — intentional, in scope for the parity contract).
import { readFileSync } from "node:fs";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  } catch {}
  return null;
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`session-end (codex): module-load failure (failing open): ${err.message ?? err}\n`);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`session-end (codex): module-load rejection (failing open): ${err && err.message ? err.message : err}\n`);
  process.exit(0);
});

if (process.env.CODEX_BUDDY_TEST_THROW === "hookLoad") {
  throw new Error("CODEX_BUDDY_TEST_THROW=hookLoad simulated module-load failure");
}

// Phase 1: lib/jobs.mjs doesn't exist yet — fail-open catches the ENOENT.
const { listJobs, updateJob } = await import("../scripts/lib/jobs.mjs");

const input = readHookInput();
const projectDir =
  input?.cwd ??
  process.env.CLAUDE_PROJECT_DIR ??
  process.cwd();

const list = listJobs(projectDir);
if (!list.ok) {
  process.stderr.write(`session-end (codex): failed to list jobs: ${list.error}\n`);
  process.exit(1);
}

let errored = false;
for (const j of list.value) {
  if (j.status === "running") {
    // Best-effort serialization. Same CAS race documented in opencode's
    // session-end.mjs — both supervisor and SessionEnd can read "running",
    // both pass the check, last writer wins. Worst case: a job that
    // completed gets stamped "session-ended"; recoverable via events file.
    // Proper flock(2) is queued for the codex equivalent of opencode plan-007.
    const r = updateJob(projectDir, j.id, { status: "session-ended" }, { expectedStatus: "running" });
    if (!r.ok && !/status changed/i.test(r.error)) {
      process.stderr.write(`session-end (codex): failed to update job ${j.id}: ${r.error}\n`);
      errored = true;
    }
  }
}
process.exit(errored ? 1 : 0);
