import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
// Anchored on the service=session id=ses_ marker — stable across opencode log
// format changes to other services. The INFO/timestamp prefix may shift but
// the kv-pair format is stable.
const SESSION_CREATED_RE = /service=session\s+id=(ses_[A-Za-z0-9]+)/;
const LIST_TIMEOUT_MS = 10_000;

function runSessionList(binary, opts = {}) {
  const args = ["session", "list", "--format", "json"];
  if (opts.maxCount) args.push("--max-count", String(opts.maxCount));
  try {
    const raw = execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LIST_TIMEOUT_MS,
    });
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: true, value: [] };
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return { ok: false, error: `session list returned non-JSON: ${err.message}` };
    }
    const sessions = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
    return { ok: true, value: sessions };
  } catch (err) {
    return { ok: false, error: `session list failed: ${err.message}` };
  }
}

function normalisePath(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Pre-flight: does this session-id still exist on opencode's side?
// Returns { ok: true, exists: true | false } on success;
// { ok: false, error } if the CLI itself failed (binary missing, etc.).
export function verifySessionExists(binary, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return { ok: true, exists: false };
  }
  // Generous max-count: a session not touched recently could fall outside small
  // windows. opencode session list sorts by updated desc; 1000 is plenty.
  const r = runSessionList(binary, { maxCount: 1000 });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, exists: r.value.some((s) => s?.id === sessionId) };
}

// Fallback capture (used ONLY when stderr parse fails).
// CAVEAT: under concurrent dispatches in the same cwd but different (role,
// model) tuples, "most-recent-updated within cwd" can pick the wrong session.
// Acceptable trade-off because stderr is the primary mechanism (deterministic
// per-process); session list is a safety net for log-format changes.
export function captureLatestSessionForCwd(binary, cwd) {
  const r = runSessionList(binary, { maxCount: 50 });
  if (!r.ok) return r;
  const cwdReal = normalisePath(cwd);
  const matching = r.value.filter((s) =>
    SESSION_ID_RE.test(s?.id ?? "") &&
    normalisePath(s?.directory ?? "") === cwdReal,
  );
  if (matching.length === 0) return { ok: true, value: null };
  matching.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return { ok: true, value: matching[0].id };
}

// Primary capture: parse the stderr buffer for INFO ... service=session id=ses_<id> ...
// Stderr is deterministic for OUR specific opencode invocation, so this
// disambiguates correctly even under concurrent unrelated same-cwd dispatches.
export function captureSessionIdFromStderr(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  for (const line of stderr.split("\n")) {
    const m = SESSION_CREATED_RE.exec(line);
    if (m) return m[1];
  }
  return null;
}
