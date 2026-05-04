#!/usr/bin/env node
// Supervisor for /opencode:run --background. Owns one opencode child process,
// captures its stdout/stderr to job files, parses NDJSON events for the parsed
// assistant text, and atomically updates the job state on close.

import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { updateJob, jobsDir } from "./jobs.mjs";

const [, , jobId, projectDir, binary, cwd, ...opencodeArgs] = process.argv;

if (!jobId || !projectDir || !binary || !cwd) {
  process.stderr.write("supervisor: missing required argv (jobId, projectDir, binary, cwd)\n");
  process.exit(2);
}

process.title = `buddy-supervisor:${jobId}`;

const stdoutPath = join(jobsDir(projectDir), `${jobId}.stdout`);
const stderrPath = join(jobsDir(projectDir), `${jobId}.stderr`);
const eventsPath = join(jobsDir(projectDir), `${jobId}.events`);
const errorPath  = join(jobsDir(projectDir), `${jobId}.supervisor-error`);

writeFileSync(stdoutPath, "");
writeFileSync(stderrPath, "");
writeFileSync(eventsPath, "");

process.on("uncaughtException", (err) => {
  try {
    writeFileSync(errorPath, `supervisor uncaught: ${err.stack ?? err.message ?? err}\n`);
    updateJob(projectDir, jobId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      exit_code: null,
    }, { expectedStatus: "running" });
  } catch {}
  process.exit(1);
});

let child;
try {
  child = spawn(binary, opencodeArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
  writeFileSync(errorPath, `supervisor spawn failed: ${err.message}\n`);
  updateJob(projectDir, jobId, {
    status: "failed",
    finished_at: new Date().toISOString(),
    exit_code: null,
  }, { expectedStatus: "running" });
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
  updateJob(projectDir, jobId, {
    status: "failed",
    finished_at: new Date().toISOString(),
    exit_code: null,
  }, { expectedStatus: "running" });
  process.exit(1);
});

child.on("close", (code, signal) => {
  // R3-1: line-by-line drain of stdoutBuf. The buffer may contain MULTIPLE
  // complete events plus a trailing partial — parse each independently.
  // R3-6: do NOT re-append to eventsPath; the streaming `data` handler already
  // wrote the raw bytes.
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

  // Best-effort CAS: only mark completed/failed if status is still "running".
  // A concurrent cancel that flipped the status to "cancelled" wins.
  const status = code === 0 ? "completed" : "failed";
  updateJob(projectDir, jobId, {
    status,
    finished_at: new Date().toISOString(),
    exit_code: code,
  }, { expectedStatus: "running" });
  process.exit(code ?? 0);
});
