#!/usr/bin/env node
// Session-start hook: detects orphaned codex background jobs from prior sessions.
//
// Plan-007 Phase 1 (carries plan-006 Phase 4 H4 forward from day 1): fail-open
// ESM ordering matches plugins/opencode/hooks/session-start.mjs:
//   1. Static node:* imports only (cannot fail at module load).
//   2. Register uncaughtException + unhandledRejection handlers BEFORE
//      dynamic imports — module-load failures exit 0 (fail-open) so a
//      broken plugin doesn't break Claude Code's session boot.
//   3. Dynamic imports of own modules AFTER the handlers are registered.
//   4. Runtime errors AFTER imports resolve still exit with their actual
//      code — fail-open applies to ESM-load failures only.
//
// Note: Phase 1 ships this hook script but the dynamic-imported modules
// (lib/jobs.mjs, lib/pid-identity.mjs) don't exist until Phases 2-3. The
// fail-open handler catches the ENOENT and exits 0 silently. Phase 3
// makes the orphan-detection logic functional.
import { readFileSync } from "node:fs";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  } catch {}
  return null;
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`session-start (codex): module-load failure (failing open): ${err.message ?? err}\n`);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`session-start (codex): module-load rejection (failing open): ${err && err.message ? err.message : err}\n`);
  process.exit(0);
});

// Test seam: CODEX_BUDDY_TEST_THROW=hookLoad forces a load-time throw so the
// fail-open path can be exercised in tests. Parity with OPENCODE_BUDDY_TEST_THROW.
if (process.env.CODEX_BUDDY_TEST_THROW === "hookLoad") {
  throw new Error("CODEX_BUDDY_TEST_THROW=hookLoad simulated module-load failure");
}

// Phase 1: lib/jobs.mjs + lib/pid-identity.mjs don't exist yet.
// The dynamic-import below throws ENOENT; uncaughtException catches it; exit 0.
// Phase 3 makes these resolvable, at which point the body below runs.
const { listJobs } = await import("../scripts/lib/jobs.mjs");
const { pidIsOurSupervisor } = await import("../scripts/lib/pid-identity.mjs");

const input = readHookInput();
const projectDir =
  input?.cwd ??
  process.env.CLAUDE_PROJECT_DIR ??
  process.cwd();

const list = listJobs(projectDir);
if (!list.ok) process.exit(0);

const orphans = list.value.filter((j) => {
  if (j.status === "session-ended") return true;
  if (j.status === "running" && !pidIsOurSupervisor(j.pid, j.id)) return true;
  return false;
});

if (orphans.length > 0) {
  const newest = orphans.slice(0, 3).map((j) => j.id).join(", ");
  const more = orphans.length > 3 ? ` (and ${orphans.length - 3} more)` : "";
  process.stdout.write(
    `${orphans.length} orphaned codex job(s) from a prior session: ${newest}${more}.\n` +
    `Run \`/codex:status\` to inspect, \`/codex:result <id>\` for output, \`/codex:cancel <id>\` to clean up.\n`,
  );
}
process.exit(0);
