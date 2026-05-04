import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createJob, listJobs, updateJob } from "../../plugins/opencode/scripts/lib/jobs.mjs";
import { makeTempRepo } from "./helpers.mjs";

const SESSION_START = resolve("plugins/opencode/hooks/session-start.mjs");
const SESSION_END = resolve("plugins/opencode/hooks/session-end.mjs");

function runHook(scriptPath, env, stdinPayload = null) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
    if (stdinPayload !== null) {
      child.stdin.write(stdinPayload);
    }
    child.stdin.end();
  });
}

test("session-start with no jobs prints nothing (silent)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runHook(SESSION_START, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "");
  } finally {
    cleanup();
  }
});

test("session-start with no orphans (only completed jobs) prints nothing", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1, summary: "done" });
    updateJob(dir, job.id, { status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });
    const result = await runHook(SESSION_START, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "");
  } finally {
    cleanup();
  }
});

test("session-start with orphaned jobs prints a one-line summary with job IDs", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    createJob(dir, { kind: "run", model: "x/y", pid: 2147483647, summary: "abandoned" });
    const result = await runHook(SESSION_START, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /1 orphaned opencode job/i);
  } finally {
    cleanup();
  }
});

test("session-start with session-ended jobs counts them as orphans", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1, summary: "ended" });
    updateJob(dir, job.id, { status: "session-ended" });
    const result = await runHook(SESSION_START, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /1 orphaned/i);
  } finally {
    cleanup();
  }
});

test("session-end marks all running jobs as session-ended", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    createJob(dir, { kind: "run", model: "x/y", pid: 1, summary: "in-flight 1" });
    createJob(dir, { kind: "run", model: "x/y", pid: 2, summary: "in-flight 2" });
    const result = await runHook(SESSION_END, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    const list = listJobs(dir);
    assert.equal(list.value.length, 2);
    for (const j of list.value) {
      assert.equal(j.status, "session-ended");
    }
  } finally {
    cleanup();
  }
});

test("session-end leaves completed jobs alone", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const a = createJob(dir, { kind: "run", model: "x/y", pid: 1, summary: "done" });
    updateJob(dir, a.id, { status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });
    const b = createJob(dir, { kind: "run", model: "x/y", pid: 2, summary: "running" });
    await runHook(SESSION_END, { CLAUDE_PROJECT_DIR: dir });
    const aAfter = listJobs(dir).value.find((j) => j.id === a.id);
    const bAfter = listJobs(dir).value.find((j) => j.id === b.id);
    assert.equal(aAfter.status, "completed");
    assert.equal(bAfter.status, "session-ended");
  } finally {
    cleanup();
  }
});

test("session-start reads cwd from stdin JSON (Claude Code hook contract)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    createJob(dir, { kind: "run", model: "x/y", pid: 2147483647, summary: "abandoned" });
    // Pipe hook input JSON instead of using env-var fallback. Use a stale env
    // dir for CLAUDE_PROJECT_DIR to ensure stdin wins.
    const result = await runHook(SESSION_START, { CLAUDE_PROJECT_DIR: "/nonexistent" }, JSON.stringify({ cwd: dir }));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /1 orphaned/i);
  } finally {
    cleanup();
  }
});

test("session-end reads cwd from stdin JSON", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    createJob(dir, { kind: "run", model: "x/y", pid: 1, summary: "running" });
    const result = await runHook(SESSION_END, { CLAUDE_PROJECT_DIR: "/nonexistent" }, JSON.stringify({ cwd: dir }));
    assert.equal(result.code, 0);
    const list = listJobs(dir);
    assert.equal(list.value[0].status, "session-ended");
  } finally {
    cleanup();
  }
});
