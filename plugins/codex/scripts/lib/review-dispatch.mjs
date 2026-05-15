// Plan-007 Phase 4: codex-specific dispatch orchestrator.
//
// Wraps invokeCodexRaw with the session-continuity flow:
//   1. Resolve session key.
//   2. Acquire per-tuple lock (best-effort; lock contention → degraded mode).
//   3. Load stored thread_id (if any).
//   4. Pre-flight verify the stored id still exists (~/.codex/sessions/<UUID>.jsonl).
//   5. Build codex argv. Two shapes based on resume:
//      - Fresh: `codex exec --json --sandbox <mode> -C <cwd> [...flags] <prompt>`
//      - Resume: `codex exec resume --json --skip-git-repo-check <UUID> [...flags] <prompt>`
//      Per Phase 1.5 gate 3 caveat, `--sandbox` is NOT accepted on `resume`;
//      sandbox flows through `-c sandbox.mode=<mode>` config override.
//   6. Invoke.
//   7. Stale-session backup detection ("Session not found: <UUID>" in stderr) — retry fresh.
//   8. Capture thread_id from first-line thread.started in stdout (Phase 1.5 gate 2).
//   9. Persist thread_id if different from existing.

import { invokeCodexRaw } from "./invoke.mjs";
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
  captureThreadIdFromStdout,
  staleSessionInStderr,
} from "./session-capture.mjs";

// Build codex argv for a fresh invocation (no resume).
function buildFreshArgs({ cwd, sandbox, model, variant, prompt }) {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox, "-C", cwd];
  if (model) args.push("--model", model);
  if (variant) args.push("-c", `model_reasoning_effort=${variant}`);
  args.push(prompt);
  return args;
}

// Build codex argv for resume. Per Phase 1.5 gate 3:
//   `codex exec resume <UUID> [PROMPT]` accepts positional prompt.
//   `--sandbox` flag IS NOT accepted on resume; use `-c sandbox.mode=<mode>`.
function buildResumeArgs({ uuid, sandbox, model, variant, prompt }) {
  const args = ["exec", "resume", "--json", "--skip-git-repo-check"];
  // Sandbox config flows through -c for resume (the --sandbox flag is rejected).
  args.push("-c", `sandbox.mode=${sandbox}`);
  if (model) args.push("--model", model);
  if (variant) args.push("-c", `model_reasoning_effort=${variant}`);
  args.push(uuid, prompt);
  return args;
}

// High-level dispatch. Inputs:
//   binary, cwd, projectDir — environment.
//   role, model, variant, sandbox — describe the dispatch shape.
//   prompt — text to send.
//   sessionKeyOverride — optional --session-key value.
//   reset — if true, delete stored session-id before dispatch.
//   noSession — if true, skip reuse AND skip save.
//   invokeImpl — injectable for tests; defaults to invokeCodexRaw.
//
// Returns: { ok, text, threadId, sessionKey, degraded?, error?, stderr?, exit_code? }
//   - threadId: null if degraded or noSession; else captured-or-existing UUID.
//   - degraded: true means lock contention forced fresh-without-save mode.
export async function dispatchCodex({
  binary,
  cwd,
  projectDir,
  role,
  model,
  variant,
  sandbox = "read-only",
  prompt,
  sessionKeyOverride = null,
  reset = false,
  noSession = false,
  reuseExisting = true,
  invokeImpl = invokeCodexRaw,
}) {
  const key = currentSessionKey({ cwd, override: sessionKeyOverride });

  // --no-session short-circuit: never read or write the .session-id file;
  // lock isn't needed.
  if (noSession) {
    const args = buildFreshArgs({ cwd, sandbox, model, variant, prompt });
    const result = await invokeImpl({ binary, args, cwd });
    return { ...result, threadId: null, sessionKey: key };
  }

  // Acquire lock around the load → invoke → save critical section.
  const lock = acquireSessionLock(projectDir, key, role, model);
  if (!lock.ok) {
    process.stderr.write(
      `warn: another codex dispatch holds the session lock for ${key}/${role}/${model}; ` +
      `running without session continuity to avoid race.\n`,
    );
    if (reset) {
      process.stderr.write(`warn: --reset ignored because another dispatch holds the lock\n`);
    }
    const args = buildFreshArgs({ cwd, sandbox, model, variant, prompt });
    const result = await invokeImpl({ binary, args, cwd });
    return { ...result, threadId: null, sessionKey: key, degraded: true };
  }

  try {
    if (reset) deleteSessionId(projectDir, key, role, model);
    let existing = loadSessionId(projectDir, key, role, model).value;
    const wantResume = existing !== null && reuseExisting;

    // Pre-flight: verify the stored UUID still exists on codex's side
    // (~/.codex/sessions/<UUID>.jsonl).
    if (wantResume) {
      const verify = verifySessionExists(binary, existing);
      if (verify.ok && !verify.exists) {
        deleteSessionId(projectDir, key, role, model);
        existing = null;
      }
      // verify.ok === false → CLI/fs failed; fall through and rely on the
      // stderr-backup stale detection at runtime.
    }

    let args = existing !== null && reuseExisting
      ? buildResumeArgs({ uuid: existing, sandbox, model, variant, prompt })
      : buildFreshArgs({ cwd, sandbox, model, variant, prompt });

    let invocation = await invokeImpl({ binary, args, cwd });

    // Backup stale-session detection for the race window between pre-flight
    // and run. Codex emits "Session not found: <UUID>" to stderr if the
    // resume target was garbage-collected.
    if (existing !== null) {
      const staleUuid = staleSessionInStderr(invocation.stderr ?? "");
      if (staleUuid && staleUuid.toLowerCase() === existing.toLowerCase()) {
        deleteSessionId(projectDir, key, role, model);
        const freshArgs = buildFreshArgs({ cwd, sandbox, model, variant, prompt });
        invocation = await invokeImpl({ binary, args: freshArgs, cwd });
        existing = null;
      }
    }

    if (!invocation.ok) {
      return { ...invocation, threadId: null, sessionKey: key };
    }

    // Capture priority: stdout first-line thread.started (Phase 1.5 gate 2)
    // → fallback null (codex has no session-list-by-cwd equivalent).
    // invocation.threadId is set by invokeCodexRaw, but as a defense in depth
    // re-extract from the buffer to handle test injectors that bypass it.
    let captured = invocation.threadId ?? captureThreadIdFromStdout(invocation.stdout ?? "");
    if (captured === null) {
      const listCapture = captureLatestSessionForCwd(binary, cwd);
      if (listCapture.ok && listCapture.value) captured = listCapture.value;
    }

    if (captured !== null && captured !== existing) {
      const save = saveSessionId(projectDir, key, role, model, captured);
      if (!save.ok) process.stderr.write(`warn: failed to save session-id: ${save.error}\n`);
    }

    return {
      ...invocation,
      threadId: captured ?? existing ?? null,
      sessionKey: key,
    };
  } finally {
    lock.release();
  }
}
