import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { createJob, updateJob } from "../../plugins/opencode/scripts/lib/jobs.mjs";

test("status with no jobs prints a 'no jobs' message", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["status"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no jobs found/i);
  } finally {
    cleanup();
  }
});

test("status with jobs prints a markdown table sorted by started_at desc", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    createJob(dir, { kind: "run", model: "vendor/a", summary: "first task" });
    await new Promise((r) => setTimeout(r, 5));
    const b = createJob(dir, { kind: "review", model: "vendor/b", summary: "second task" });
    updateJob(dir, b.id, { status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });

    const result = await runCompanion(["status"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /first task/);
    assert.match(result.stdout, /second task/);
    assert.match(result.stdout, /running/);
    assert.match(result.stdout, /completed/);
    assert.ok(result.stdout.indexOf("second task") < result.stdout.indexOf("first task"));
  } finally {
    cleanup();
  }
});

test("status <job-id> prints the full record for that job", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const a = createJob(dir, { kind: "run", model: "vendor/a", summary: "specific task" });
    const result = await runCompanion(["status", a.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(a.id));
    assert.match(result.stdout, /specific task/);
    assert.match(result.stdout, /vendor\/a/);
    assert.match(result.stdout, /running/);
  } finally {
    cleanup();
  }
});

test("status <unknown-id> prints a clear error", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["status", "job_nonexistent"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /not found/i);
  } finally {
    cleanup();
  }
});
