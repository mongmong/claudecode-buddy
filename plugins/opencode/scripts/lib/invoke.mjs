import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes
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

export function invokeOpencode({
  binary,
  prompt,
  cwd,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolveResult) => {
    const args = ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd];
    if (model) args.push("--model", model);
    args.push(prompt);

    let child;
    try {
      child = spawn(binary, args, { cwd });
    } catch (err) {
      resolveResult({ ok: false, error: `failed to spawn ${binary}: ${err.message}` });
      return;
    }

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
