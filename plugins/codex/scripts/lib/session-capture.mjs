// Plan-007 Phase 4 (combined with Phase 3 supervisor): codex-specific
// session-id capture. Grounded in Phase 1.5 gate 2 finding:
//   `codex exec --json` emits `{"type":"thread.started","thread_id":"<UUID>"}`
//   as the FIRST stdout line. No stderr regex needed (simpler than opencode's
//   `service=session id=ses_*` stderr pattern).
//
// This module exists separately from invoke.mjs so the supervisor can capture
// the thread_id from its accumulated stdout buffer without a circular import
// to invoke.mjs. The implementation is structurally identical to invoke.mjs's
// `captureThreadId` — duplicated here as a stand-alone function so supervisor
// can call it directly.

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function captureThreadIdFromStdout(stdoutBuf) {
  if (typeof stdoutBuf !== "string" || stdoutBuf.length === 0) return null;
  for (const line of stdoutBuf.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (ev.type === "thread.started" && typeof ev.thread_id === "string" && THREAD_ID_RE.test(ev.thread_id)) {
      return ev.thread_id;
    }
    // Per Phase 1.5 gate 2: thread.started is always the first event when
    // present. If the first event isn't thread.started, give up (no UUID
    // capturable from this stream).
    if (ev.type && ev.type !== "thread.started") return null;
  }
  return null;
}

// Stale-session detection: codex emits "Session not found: <UUID>" to stderr
// when resume is called with a stale UUID (verified locally; this is the
// codex analog of opencode's "Session not found: ses_*"). The plugin's
// dispatcher uses this to discard a stored UUID that codex has since
// garbage-collected.
const STALE_SESSION_RE = /Session\s+not\s+found:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function staleSessionInStderr(stderrBuf) {
  if (typeof stderrBuf !== "string") return null;
  const m = stderrBuf.match(STALE_SESSION_RE);
  return m ? m[1] : null;
}

// Verify a stored thread_id is still valid. Codex stores sessions at
// $CODEX_HOME/sessions/<uuid>.jsonl (or ~/.codex/sessions/<uuid>.jsonl).
// We just check if the file exists. If yes → valid. If no → garbage-collected.
// Returns { ok: true, exists: boolean } on success, { ok: false, error } on failure.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function verifySessionExists(_binary, threadId) {
  if (!THREAD_ID_RE.test(threadId)) {
    return { ok: false, error: `invalid thread_id format: ${threadId}` };
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const candidatePaths = [
    join(codexHome, "sessions", `${threadId}.jsonl`),
    // Also check archived_sessions; codex moves old ones there.
    join(codexHome, "archived_sessions", `${threadId}.jsonl`),
  ];
  for (const p of candidatePaths) {
    if (existsSync(p)) return { ok: true, exists: true };
  }
  return { ok: true, exists: false };
}

// Codex has no equivalent of opencode's `session list --cwd <dir>` for
// reverse-resolving a session-id by working directory. Capture-fallback is
// therefore null for codex — if stdout-first-line parsing fails, there's
// no further recovery. Returns { ok: true, value: null } so callers don't
// need null-vs-error branching.
export function captureLatestSessionForCwd(_binary, _cwd) {
  return { ok: true, value: null };
}
