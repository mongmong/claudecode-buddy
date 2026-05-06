import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 1_200_000; // 20 minutes — long-running plan/code reviews on slower providers (deepseek-v4-pro, glm-5.1) routinely run 6-12 min; 5min was too tight in practice
const KILL_GRACE_MS = 2000;

function parseEvents(stdout) {
  // Real opencode events: { type: "text", part: { type: "text", messageID: "...", text: "..." } }
  // Group text by messageID. The "final" message is the one whose LAST text event
  // arrived latest in the stream — robust under interleaving where one messageID
  // emits early, another emits in the middle, and the first resumes at the end.
  const buffers = new Map(); // messageID -> { text: "", lastIdx: number }
  let idx = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-JSON log lines
    }
    if (ev.type !== "text") continue;
    if (!ev.part || ev.part.type !== "text") continue;
    if (typeof ev.part.text !== "string") continue;
    const id = ev.part.messageID ?? "_unknown_";
    if (!buffers.has(id)) buffers.set(id, { text: "", lastIdx: 0 });
    const entry = buffers.get(id);
    entry.text += ev.part.text;
    entry.lastIdx = idx++;
  }

  if (buffers.size === 0) return [];
  return [...buffers.values()]
    .sort((a, b) => a.lastIdx - b.lastIdx)
    .map((entry) => entry.text);
}

// Lower-level entry point: caller supplies the full opencode args list.
// Used by /opencode:run which needs to control whether --dangerously-skip-permissions
// is included (driven by --yolo opt-in) instead of having it always-on.
export function invokeOpencodeRaw({
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
      resolveResult({ ok: false, error: `failed to invoke opencode: ${err.message}`, stderr, exit_code: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveResult({ ok: false, error: `opencode timed out after ${timeoutMs} ms (signal ${signal ?? "?"})\nstderr: ${stderr}`, stderr, exit_code: code });
        return;
      }
      if (code !== 0) {
        resolveResult({ ok: false, error: `opencode exited with code ${code}\nstderr: ${stderr}`, stderr, exit_code: code });
        return;
      }
      const messages = parseEvents(stdout);
      if (messages.length === 0) {
        // Empty-text → ok:true with empty body. Plan 002 dispatcher uses
        // staleSessionInStderr() on the stderr to decide if this is a
        // recoverable stale-session situation (silent opencode failure mode).
        resolveResult({ ok: true, text: "", stderr, exit_code: code });
        return;
      }
      resolveResult({ ok: true, text: messages[messages.length - 1], stderr, exit_code: code });
    });
  });
}

export function invokeOpencode({
  binary,
  prompt,
  cwd,
  model,
  variant,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolveResult) => {
    const args = ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd];
    if (model) args.push("--model", model);
    if (variant) args.push("--variant", variant);
    args.push(prompt);

    let child;
    try {
      child = spawn(binary, args, { cwd });
    } catch (err) {
      resolveResult({ ok: false, error: `failed to spawn ${binary}: ${err.message}` });
      return;
    }

    // We never write to opencode's stdin. Close it immediately so opencode
    // doesn't hang waiting for EOF if any future version reads stdin.
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
      resolveResult({ ok: false, error: `failed to invoke opencode: ${err.message}` });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveResult({
          ok: false,
          error: `opencode timed out after ${timeoutMs} ms (signal ${signal ?? "?"})\nstderr: ${stderr}`,
        });
        return;
      }
      if (code !== 0) {
        resolveResult({
          ok: false,
          error: `opencode exited with code ${code}\nstderr: ${stderr}`,
        });
        return;
      }
      const messages = parseEvents(stdout);
      if (messages.length === 0) {
        resolveResult({
          ok: false,
          error: `opencode produced no assistant text events\nstdout: ${stdout}`,
        });
        return;
      }
      resolveResult({ ok: true, text: messages[messages.length - 1] });
    });
  });
}
