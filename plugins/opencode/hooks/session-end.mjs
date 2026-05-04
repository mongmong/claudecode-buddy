#!/usr/bin/env node
import { listJobs, updateJob } from "../scripts/lib/jobs.mjs";
import { readFileSync } from "node:fs";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  } catch {}
  return null;
}

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
