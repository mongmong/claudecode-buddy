// Plan-006 Phase 5 (C2 + M2). Identity check for "is this PID our
// supervisor for the given jobId?" — defends against PID reuse.
//
// The supervisor sets `process.title = "buddy-supervisor:<jobId>"`. On Linux,
// this overwrites argv (uv_set_process_title + argv overwrite), so
// /proc/<pid>/cmdline shows the title — both the "buddy-supervisor" prefix
// AND the jobId. We require BOTH substrings to defend against a reused PID
// running an unrelated command whose argv happens to contain the jobId.
//
// On macOS, /proc isn't available; we shell out to `ps -o command= -p <pid>`.
// `ps` reads the kern.proc.<pid>.argv sysctl and reflects process.title in
// the same way Linux's /proc/<pid>/cmdline does for our supervisor.
//
// Injectable for tests: `{platform, cmdlineReader, isAlive}` lets the unit
// tests verify both Linux and darwin branches on Linux CI by passing
// canned cmdline strings — no real macOS host required.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function defaultIsAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function defaultCmdlineReader(platform) {
  if (platform === "linux") {
    return (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8");
  }
  if (platform === "darwin") {
    return (pid) => execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  // Other platforms (e.g. Windows) have no implementation here. Return a
  // reader that always throws — pidIsOurSupervisor will then reject.
  return () => { throw new Error(`pidIsOurSupervisor: unsupported platform ${platform}`); };
}

export function pidIsOurSupervisor(pid, jobId, opts = {}) {
  if (!pid) return false;
  const platform = opts.platform ?? process.platform;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  if (!isAlive(pid)) return false;
  const cmdlineReader = opts.cmdlineReader ?? defaultCmdlineReader(platform);
  let cmdline;
  try {
    cmdline = cmdlineReader(pid);
  } catch {
    return false;
  }
  return cmdline.includes("buddy-supervisor") && cmdline.includes(jobId);
}
