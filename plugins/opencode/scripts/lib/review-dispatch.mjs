import { invokeOpencodeRaw } from "./invoke.mjs";
import {
  currentSessionKey,
  loadSessionId,
  saveSessionId,
  deleteSessionId,
  acquireSessionLock,
} from "./sessions.mjs";
import {
  verifySessionExists,
  captureLatestSessionForCwd,
  captureSessionIdFromStderr,
} from "./session-capture.mjs";

// Defensive backup: detect "Session not found: <storedId>" in captured stderr.
// Fires when opencode's session is deleted out-of-band between our pre-flight
// verification and the actual run (rare race window). Case-insensitive match
// for forward-compat with log format shifts.
const STALE_SESSION_MARKER = /session not found: /i;
function staleSessionInStderr(stderr, sessionId) {
  if (typeof stderr !== "string" || sessionId === null) return false;
  // Look for the marker followed by our specific session-id (substring match).
  // We don't use a regex with the id interpolated because session-ids are
  // alphanumeric (already escape-safe), but keeping the substring approach
  // tolerates surrounding punctuation/quoting variations.
  const m = stderr.match(STALE_SESSION_MARKER);
  if (!m) return false;
  // Confirm OUR session-id appears after the marker (not some other one).
  return stderr.toLowerCase().includes(`session not found: ${sessionId.toLowerCase()}`);
}

// High-level dispatch entry point. Resolves the session key, loads any stored
// session-id, builds opencode argv (adding --session when applicable), invokes
// opencode, captures the new session-id, persists it, returns the result.
//
// Inputs:
//   binary, cwd, projectDir — environment.
//   role, model, prompt — describe the dispatch.
//   opencodeArgs — additional args (e.g. ["run", "--format", "json", ...]).
//                  --session and the prompt are appended internally.
//   sessionKeyOverride — optional --session-key value (default: derive from cwd).
//   reset — if true, delete stored session-id before dispatch.
//   noSession — if true, skip reuse for this call AND skip save (one-off).
//   invokeImpl — injectable for tests; defaults to invokeOpencodeRaw.
//
// Returns: { ok, text, error?, stderr?, sessionId, sessionKey, degraded? }
//   - degraded: true means lock contention forced fresh-without-save mode.
//   - sessionId: null if degraded or noSession; else captured-or-existing id.
export async function dispatchOpencode({
  binary,
  cwd,
  projectDir,
  role,
  model,
  prompt,
  opencodeArgs = [],
  sessionKeyOverride = null,
  reset = false,
  noSession = false,
  reuseExisting = true,
  invokeImpl = invokeOpencodeRaw,
}) {
  const key = currentSessionKey({ cwd, override: sessionKeyOverride });

  // --no-session short-circuit (per code-review): a one-off detached call
  // never reads or writes the .session-id file, so the lock isn't needed.
  // Skipping lock acquisition prevents --no-session calls from forcing
  // concurrent normal calls into degraded mode unnecessarily.
  if (noSession) {
    const args = [...opencodeArgs, "--print-logs", "--log-level", "INFO", prompt];
    const result = await invokeImpl({ binary, args, cwd });
    return { ...result, sessionId: null, sessionKey: key };
  }

  // Acquire lock around the load → invoke → save critical section. On
  // contention, run in degraded mode (no continuity for this call) so the
  // lock-holder's session-id stays authoritative.
  const lock = acquireSessionLock(projectDir, key, role, model);
  if (!lock.ok) {
    process.stderr.write(
      `warn: another opencode dispatch holds the session lock for ${key}/${role}/${model}; ` +
      `running without session continuity to avoid race.\n`,
    );
    if (reset) {
      process.stderr.write(`warn: --reset ignored because another dispatch holds the lock\n`);
    }
    const args = [...opencodeArgs, "--print-logs", "--log-level", "INFO", prompt];
    const result = await invokeImpl({ binary, args, cwd });
    return { ...result, sessionId: null, sessionKey: key, degraded: true };
  }

  try {
    if (reset) deleteSessionId(projectDir, key, role, model);
    let existing = noSession ? null : loadSessionId(projectDir, key, role, model).value;
    const wantResume = existing !== null && reuseExisting && !noSession;

    // Pre-flight: verify the stored id is alive on opencode's side.
    if (wantResume) {
      const verify = verifySessionExists(binary, existing);
      if (verify.ok && !verify.exists) {
        deleteSessionId(projectDir, key, role, model);
        existing = null;
      }
      // verify.ok === false → CLI itself failed; fall through and rely on the
      // stderr-backup stale detection.
    }

    const args = [...opencodeArgs, "--print-logs", "--log-level", "INFO"];
    if (existing !== null && reuseExisting && !noSession) {
      args.push("--session", existing);
    }
    args.push(prompt);

    let invocation = await invokeImpl({ binary, args, cwd });

    // Backup stale-session detection for the race window between pre-flight and run.
    if (existing !== null && staleSessionInStderr(invocation.stderr ?? "", existing)) {
      deleteSessionId(projectDir, key, role, model);
      const freshArgs = [...opencodeArgs, "--print-logs", "--log-level", "INFO", prompt];
      invocation = await invokeImpl({ binary, args: freshArgs, cwd });
      existing = null;
    }

    if (!invocation.ok) {
      // Explicit sessionId: null on error path so the contract holds (callers
      // that destructure result.sessionId get null, not undefined).
      return { ...invocation, sessionId: null, sessionKey: key };
    }

    // Capture priority: stderr (deterministic per-process) → session list (fallback).
    let captured = captureSessionIdFromStderr(invocation.stderr ?? "");
    if (captured === null) {
      const listCapture = captureLatestSessionForCwd(binary, cwd);
      if (listCapture.ok && listCapture.value) {
        captured = listCapture.value;
        process.stderr.write(
          `warn: session-id captured via session list fallback (stderr parse failed). ` +
          `If concurrent same-cwd dispatches were running, this may have picked the wrong session.\n`,
        );
      }
    }

    // --no-session: skip persistence so the original stored id survives unchanged.
    if (!noSession && captured !== null && captured !== existing) {
      const save = saveSessionId(projectDir, key, role, model, captured);
      if (!save.ok) process.stderr.write(`warn: failed to save session-id: ${save.error}\n`);
    }

    return {
      ...invocation,
      sessionId: noSession ? null : (captured ?? existing ?? null),
      sessionKey: key,
    };
  } finally {
    lock.release();
  }
}
