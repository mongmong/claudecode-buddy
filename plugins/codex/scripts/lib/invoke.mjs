import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 1_200_000; // 20 minutes — matches opencode's plan-006 bump.
const KILL_GRACE_MS = 2000;

// Codex `--json` event shape (verified Phase 1.5 gate 1):
//   {"type":"thread.started","thread_id":"<UUID>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{...}}
//
// Other item.type values appear for write-capable runs:
//   item.type === "file_change" — file edits (paths + kind: "add"|"modify"|"delete")
//   item.type === "command_execution" — shell commands the model ran
//
// We only extract assistant text from item.type === "agent_message" events.
// Multiple agent_message events can appear in a single turn (rare; usually
// from thinking-block emissions). We collect them in order and return the
// concatenated text (matches opencode's behavior of returning the full last
// assistant message; codex emits agent_message events as deltas, so
// concatenation is the equivalent of opencode's per-messageID accumulation).

export function parseEvents(stdout) {
  const messages = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (ev.type !== "item.completed") continue;
    if (!ev.item || ev.item.type !== "agent_message") continue;
    if (typeof ev.item.text !== "string") continue;
    messages.push(ev.item.text);
  }
  return messages;
}

// Extract the session/thread UUID from the first `thread.started` event in
// stdout. Per Phase 1.5 gate 2: this event is always the first NDJSON line
// when `codex exec --json` is invoked, so capture is cheap and reliable.
// Returns null if the event isn't found.
export function captureThreadId(stdout) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      return ev.thread_id;
    }
    // Stop scanning after the first non-thread.started event — thread.started
    // is always first when present.
    if (ev.type && ev.type !== "thread.started") return null;
  }
  return null;
}

// Lower-level entry point: caller supplies the full codex args list.
// Used by /codex:run when sandbox mode + other flags differ per invocation.
export function invokeCodexRaw({
  binary,
  args,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(binary, args, { cwd });
    } catch (err) {
      resolveResult({ ok: false, error: `failed to spawn ${binary}: ${err.message}` });
      return;
    }
    try { child.stdin.end(); } catch {}

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveResult({ ok: false, error: `failed to invoke codex: ${err.message}`, stderr, exit_code: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveResult({ ok: false, error: `codex timed out after ${timeoutMs} ms (signal ${signal ?? "?"})\nstderr: ${stderr}`, stderr, exit_code: code });
        return;
      }
      if (code !== 0) {
        resolveResult({ ok: false, error: `codex exited with code ${code}\nstderr: ${stderr}`, stderr, exit_code: code });
        return;
      }
      const messages = parseEvents(stdout);
      const threadId = captureThreadId(stdout);
      if (messages.length === 0) {
        // Empty-text → ok:true with empty body, matching opencode's contract.
        resolveResult({ ok: true, text: "", threadId, stderr, exit_code: code });
        return;
      }
      // Concatenate all agent_message events from this turn — codex can emit
      // multiple as the assistant streams thinking-blocks. The full sequence
      // is the canonical assistant output.
      resolveResult({ ok: true, text: messages.join(""), threadId, stderr, exit_code: code });
    });
  });
}

// Higher-level entry: builds codex's argv for a single exec invocation.
// - sandbox: "read-only" | "workspace-write" | "danger-full-access" (per Phase 1.5 gate 4 + R11).
// - model / variant: optional pinning.
export function invokeCodex({
  binary,
  prompt,
  cwd,
  model,
  variant,
  sandbox = "read-only",
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox, "-C", cwd];
  if (model) args.push("--model", model);
  if (variant) args.push("-c", `model_reasoning_effort=${variant}`);
  args.push(prompt);
  return invokeCodexRaw({ binary, args, cwd, timeoutMs });
}
