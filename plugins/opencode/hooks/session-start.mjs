#!/usr/bin/env node
// Session-start hook: detects orphaned opencode jobs from prior sessions.
//
// Plan-006 Phase 4 (H4): adopts the fail-open ESM ordering proven in
// stop-review-gate-hook.mjs:
//   1. Static node:* imports only (cannot fail at module load).
//   2. Register uncaughtException + unhandledRejection handlers BEFORE
//      dynamic imports, so a module-load failure (syntax/circular/etc.)
//      causes the hook to exit 0 (fail-open) rather than crash with a
//      non-zero code that could confuse Claude Code's session boot.
//   3. Dynamic imports of own modules AFTER the handlers are registered.
//   4. Runtime errors AFTER imports resolve still exit with their actual
//      code — fail-open applies to ESM-load failures only, not normal flow.
import { readFileSync } from "node:fs";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  } catch {}
  return null;
}

// Fail-open handlers — registered BEFORE dynamic imports. Catch any
// throw during module resolution / load and exit 0 so a broken plugin
// doesn't break Claude Code's session boot.
process.on("uncaughtException", (err) => {
  process.stderr.write(`session-start: module-load failure (failing open): ${err.message ?? err}\n`);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`session-start: module-load rejection (failing open): ${err && err.message ? err.message : err}\n`);
  process.exit(0);
});

// Test seam (Plan-006 Phase 4 / C3): force a load-time throw so the
// fail-open path can be exercised by tests.
if (process.env.OPENCODE_BUDDY_TEST_THROW === "hookLoad") {
  throw new Error("OPENCODE_BUDDY_TEST_THROW=hookLoad simulated module-load failure");
}

const { listJobs } = await import("../scripts/lib/jobs.mjs");
// Plan-006 Phase 5c (M2): dynamic-import the pid-identity helper so a
// load failure here also fails open per Phase 4's ESM ordering.
const { pidIsOurSupervisor } = await import("../scripts/lib/pid-identity.mjs");

const input = readHookInput();
const projectDir =
  input?.cwd ??
  process.env.CLAUDE_PROJECT_DIR ??
  process.cwd();

const list = listJobs(projectDir);
if (!list.ok) process.exit(0);

// Plan-006 Phase 5c (M2): the orphan filter now uses pidIsOurSupervisor
// (cmdline + jobId check) instead of bare isAlive. A PID that's alive
// but isn't OUR supervisor (PID reuse → some other process inherited
// the recycled pid) is correctly classified as an orphan. Previously
// any live PID was trusted as "still our supervisor running."
const orphans = list.value.filter((j) => {
  if (j.status === "session-ended") return true;
  if (j.status === "running" && !pidIsOurSupervisor(j.pid, j.id)) return true;
  return false;
});

if (orphans.length > 0) {
  const newest = orphans.slice(0, 3).map((j) => j.id).join(", ");
  const more = orphans.length > 3 ? ` (and ${orphans.length - 3} more)` : "";
  process.stdout.write(
    `${orphans.length} orphaned opencode job(s) from a prior session: ${newest}${more}.\n` +
    `Run \`/opencode:status\` to inspect, \`/opencode:result <id>\` for output, \`/opencode:cancel <id>\` to clean up.\n`,
  );
}
process.exit(0);
