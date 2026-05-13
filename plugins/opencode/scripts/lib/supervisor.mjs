#!/usr/bin/env node
// Supervisor for /opencode:run --background. Owns one opencode child process,
// captures its stdout/stderr to job files, parses NDJSON events for the parsed
// assistant text, and atomically updates the job state on close.
//
// CRITICAL ESM ORDERING (per plan 002 round-5 review):
// 1. Static imports of node:* built-ins ONLY (these cannot fail at module load).
// 2. Register uncaughtException handler in module body — runs before any
//    dynamic imports of our own modules.
// 3. Dynamic imports for own modules — these CAN fail (syntax/circular/etc.),
//    but the crash handler is now registered to catch them.
//
// (`require()` is NOT available in .mjs without createRequire(); the
//  built-ins-only static imports + dynamic-imports-for-own-modules approach
//  is simpler and avoids the createRequire ceremony.)

import {
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from "node:fs";
import { join as joinPath } from "node:path";
import { spawn } from "node:child_process";

const [, , jobId, projectDir, binary, cwd, role, sessionKey, model, noSessionRaw, degradedRaw, ...opencodeArgs] = process.argv;
const noSession = noSessionRaw === "true";
const degraded = degradedRaw === "true";

if (!jobId || !projectDir || !binary || !cwd) {
  process.stderr.write("supervisor: missing required argv (jobId, projectDir, binary, cwd, role, sessionKey, model, noSession, degraded)\n");
  process.exit(2);
}

process.title = `buddy-supervisor:${jobId}`;

// Module-scope state used by the signal handler. `child` is null until
// spawn assigns it (later in the body); `dynamicImportsReady` flips true
// after the await imports complete. The signal handler reads both, so
// they must be at module scope.
let child = null;
let dynamicImportsReady = false;
let signalHandled = false;

// Inline derivations for the crash handler — duplicate sanitiseLabel /
// sessionLockPath logic so we don't depend on dynamic imports that may not
// have completed yet.
function inlineSanitise(s) {
  if (typeof s !== "string") return "unnamed";
  const lowered = s.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, "-");
  const trimmed = replaced.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : "unnamed";
}
function inlineLockDir() {
  return joinPath(
    projectDir,
    ".claudecode-buddy",
    "opencode",
    "sessions",
    `${inlineSanitise(sessionKey)}-${inlineSanitise(role)}-${inlineSanitise(model)}.lock`,
  );
}
function inlineJobPath() {
  return joinPath(projectDir, ".claudecode-buddy", "opencode", "jobs", `${jobId}.json`);
}

// Plan-006 Phase 5a (H3, plus N1 from round-2 review): two-layer SIGTERM
// handler. Registered AT THE TOP of the module so the pre-import window
// (~5-50ms before dynamic imports resolve) is also covered — SIGTERM is a
// signal, not a thrown exception, so the existing uncaughtException
// handler does NOT cover signals.
//
// Pre-import branch: uses inline path-derivation + inline atomic JSON write
// (same primitives the existing uncaughtException handler uses).
// Post-import branch: uses the real releaseLock + updateJob from the
// dynamic-imported modules. The `dynamicImportsReady` flag gates which
// branch runs.
function handleSignal(sig) {
  if (signalHandled) return;
  signalHandled = true;
  try {
    if (dynamicImportsReady) {
      try { releaseLock(); } catch {}
      try {
        updateJob(projectDir, jobId, {
          status: "cancelled",
          finished_at: new Date().toISOString(),
          exit_code: sig === "SIGINT" ? 130 : 143,
        }, { expectedStatus: ["running", "session-ended"] });
      } catch {}
    } else {
      // Dynamic imports haven't resolved yet — inline fallback.
      try {
        if (!degraded) rmSync(inlineLockDir(), { recursive: true, force: true });
      } catch {}
      try {
        const jobPath = inlineJobPath();
        const record = JSON.parse(readFileSync(jobPath, "utf8"));
        record.status = "cancelled";
        record.exit_code = sig === "SIGINT" ? 130 : 143;
        record.finished_at = new Date().toISOString();
        const tmp = `${jobPath}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
        renameSync(tmp, jobPath);
      } catch {}
    }
  } finally {
    try { if (child && !child.killed) child.kill(sig); } catch {}
    process.exit(sig === "SIGINT" ? 130 : 143);
  }
}
process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT",  () => handleSignal("SIGINT"));

// SINGLE crash handler — does (a) lock release, (b) job-record-failed update
// via inline atomic JSON write, (c) supervisor-error breadcrumb. The previous
// v0.2.0 separate uncaughtException handler is REMOVED — its responsibility
// is folded here so a crash performs full cleanup atomically.
process.on("uncaughtException", (err) => {
  // 1. Release the lock (no token check after round-6 simplification — the
  // pure mkdir-EEXIST primitive guarantees at-most-one-holder, so this
  // process IS the holder if it's running).
  try {
    if (!degraded) {
      rmSync(inlineLockDir(), { recursive: true, force: true });
    }
  } catch {}
  // 2. Update job record to "failed" via inline atomic write.
  try {
    const jobPath = inlineJobPath();
    const record = JSON.parse(readFileSync(jobPath, "utf8"));
    record.status = "failed";
    record.exit_code = null;
    record.finished_at = new Date().toISOString();
    const tmp = `${jobPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    renameSync(tmp, jobPath);
  } catch {}
  // 3. Best-effort error breadcrumb.
  try {
    writeFileSync(
      joinPath(projectDir, ".claudecode-buddy", "opencode", "jobs", `${jobId}.supervisor-error`),
      `supervisor uncaught: ${err.stack ?? err.message ?? err}\n`,
    );
  } catch {}
  process.exit(1);
});

// Plan-006 Phase 5a test seam: OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS=N forces
// a deterministic N-ms delay BEFORE dynamic imports complete so tests can
// reliably exercise the pre-import SIGTERM branch.
if (process.env.OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS) {
  const ms = parseInt(process.env.OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS, 10);
  if (Number.isFinite(ms) && ms > 0) {
    await new Promise((r) => setTimeout(r, ms));
  }
}

// Dynamic imports for own modules — now safe since the crash handler is
// registered above.
const { updateJob, jobsDir } = await import("./jobs.mjs");
const { saveSessionId, deleteSessionId, sessionLockPath } = await import("./sessions.mjs");
const { captureSessionIdFromStderr, captureLatestSessionForCwd } = await import("./session-capture.mjs");

// Flip the flag AFTER imports resolve so the SIGTERM handler switches from
// inline-fallback to the real releaseLock/updateJob path.
dynamicImportsReady = true;

const stdoutPath = joinPath(jobsDir(projectDir), `${jobId}.stdout`);
const stderrPath = joinPath(jobsDir(projectDir), `${jobId}.stderr`);
const eventsPath = joinPath(jobsDir(projectDir), `${jobId}.events`);
const errorPath  = joinPath(jobsDir(projectDir), `${jobId}.supervisor-error`);

writeFileSync(stdoutPath, "");
writeFileSync(stderrPath, "");
writeFileSync(eventsPath, "");

function releaseLock() {
  if (degraded) return; // Parent never acquired the lock in degraded mode.
  // Simplified release after round-6: pure mkdir-EEXIST has at-most-one-holder
  // by construction, so any process running this supervisor IS the lock
  // holder. Just rmdir.
  try {
    rmSync(sessionLockPath(projectDir, sessionKey, role, model), { recursive: true, force: true });
  } catch {}
}

// `child` is module-scope (declared at the top so the SIGTERM handler can
// read it); we just assign here.
try {
  child = spawn(binary, opencodeArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
  writeFileSync(errorPath, `supervisor spawn failed: ${err.message}\n`);
  releaseLock();
  updateJob(projectDir, jobId, {
    status: "failed",
    finished_at: new Date().toISOString(),
    exit_code: null,
  }, { expectedStatus: ["running", "session-ended"] });
  process.exit(1);
}

const buffers = new Map();
let idx = 0;
let stdoutBuf = "";

child.stdout.on("data", (chunk) => {
  appendFileSync(eventsPath, chunk);
  stdoutBuf += chunk.toString("utf8");
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== "text") continue;
    if (!ev.part || ev.part.type !== "text" || typeof ev.part.text !== "string") continue;
    const id = ev.part.messageID ?? "_unknown_";
    if (!buffers.has(id)) buffers.set(id, { text: "", lastIdx: 0 });
    const entry = buffers.get(id);
    entry.text += ev.part.text;
    entry.lastIdx = idx++;
    const sorted = [...buffers.values()].sort((a, b) => a.lastIdx - b.lastIdx);
    const finalText = sorted.length > 0 ? sorted[sorted.length - 1].text : "";
    writeFileSync(stdoutPath, finalText);
  }
});

child.stderr.on("data", (chunk) => {
  appendFileSync(stderrPath, chunk);
});

child.on("error", (err) => {
  writeFileSync(errorPath, `child error: ${err.message}\n`);
  releaseLock();
  updateJob(projectDir, jobId, {
    status: "failed",
    finished_at: new Date().toISOString(),
    exit_code: null,
  }, { expectedStatus: ["running", "session-ended"] });
  process.exit(1);
});

child.on("close", (code, signal) => {
  // Line-by-line drain of trailing stdoutBuf (multiple complete events
  // possibly plus a trailing partial — parse each independently).
  if (stdoutBuf.length > 0) {
    const lines = stdoutBuf.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      if (ev.type !== "text") continue;
      if (!ev.part || ev.part.type !== "text" || typeof ev.part.text !== "string") continue;
      const id = ev.part.messageID ?? "_unknown_";
      if (!buffers.has(id)) buffers.set(id, { text: "", lastIdx: 0 });
      const entry = buffers.get(id);
      entry.text += ev.part.text;
      entry.lastIdx = idx++;
    }
    if (buffers.size > 0) {
      const sorted = [...buffers.values()].sort((a, b) => a.lastIdx - b.lastIdx);
      writeFileSync(stdoutPath, sorted[sorted.length - 1].text);
    }
    stdoutBuf = "";
  }

  // Capture + save session-id (only if !degraded && !noSession).
  if (!degraded && !noSession) {
    let captured = null;
    try {
      const stderrBuf = readFileSync(stderrPath, "utf8");
      // Stale-session detection: if our --session was stale, opencode emits
      // "Session not found: ses_<id>" to stderr. Case-insensitive match for
      // consistency with the foreground dispatcher's staleSessionInStderr().
      // We DELETE the stored session-id file here (per code-review feedback
      // from Codex round-1) so the next dispatch's pre-flight runs fresh
      // immediately — without this, the bad id sits on disk until the next
      // dispatch's pre-flight discovers it via session list query.
      const staleHit = stderrBuf.match(/session not found: (ses_[A-Za-z0-9]+)/i);
      if (staleHit) {
        process.stderr.write(`warn: opencode reported stale session ${staleHit[1]} mid-run; deleting stored id\n`);
        deleteSessionId(projectDir, sessionKey, role, model);
      } else {
        // Stderr-primary, session-list-fallback (per plan 002 capture priority).
        captured = captureSessionIdFromStderr(stderrBuf);
        if (captured === null) {
          const list = captureLatestSessionForCwd(binary, cwd);
          if (list.ok && list.value) captured = list.value;
        }
      }
    } catch {}
    if (captured !== null) {
      const save = saveSessionId(projectDir, sessionKey, role, model, captured);
      if (!save.ok) process.stderr.write(`warn: supervisor failed to save session-id: ${save.error}\n`);
    }
  }

  releaseLock();

  // Best-effort CAS: mark completed/failed unless a concurrent cancel already
  // flipped the status to "cancelled". A "session-ended" status (set by the
  // SessionEnd hook when Claude Code exits while we keep running) is also a
  // valid pre-state — when we naturally finish in a later session, our real
  // exit_code is the authoritative value.
  const status = code === 0 ? "completed" : "failed";
  updateJob(projectDir, jobId, {
    status,
    finished_at: new Date().toISOString(),
    exit_code: code,
  }, { expectedStatus: ["running", "session-ended"] });
  process.exit(code ?? 0);
});
