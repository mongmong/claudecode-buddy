#!/usr/bin/env node
import { listJobs } from "../scripts/lib/jobs.mjs";
import { readFileSync } from "node:fs";

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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
if (!list.ok) process.exit(0);

const orphans = list.value.filter((j) => {
  if (j.status === "session-ended") return true;
  if (j.status === "running" && !isAlive(j.pid)) return true;
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
