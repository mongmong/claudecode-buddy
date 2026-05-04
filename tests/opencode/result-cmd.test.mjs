import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { createJob, updateJob, jobsDir } from "../../plugins/opencode/scripts/lib/jobs.mjs";

test("result <job-id> prints the stdout file for a finished job", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", summary: "something" });
    const stdoutPath = join(jobsDir(dir), `${job.id}.stdout`);
    writeFileSync(stdoutPath, "## Findings\n\n1. Looks good.\n");
    updateJob(dir, job.id, {
      status: "completed",
      finished_at: new Date().toISOString(),
      exit_code: 0,
      stdout_path: stdoutPath,
    });

    const result = await runCompanion(["result", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /## Findings/);
    assert.match(result.stdout, /Looks good\./);
  } finally {
    cleanup();
  }
});

test("result <job-id> for a still-running job tells the user to wait", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", summary: "wip" });
    const result = await runCompanion(["result", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /still running|in progress|wait/i);
  } finally {
    cleanup();
  }
});

test("result <unknown-id> prints a clear error", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["result", "job_nonexistent"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /not found/i);
  } finally {
    cleanup();
  }
});

test("result with no <job-id> prints a clear error", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["result"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /requires a job id/i);
  } finally {
    cleanup();
  }
});

test("result for a failed job shows the failed status and missing-stdout fallback", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const job = createJob(dir, { kind: "run", model: "vendor/x", summary: "failed" });
    updateJob(dir, job.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      exit_code: 7,
      stdout_path: "/nonexistent/path",
    });
    const result = await runCompanion(["result", job.id], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no stdout captured|status: failed/i);
    assert.match(result.stdout, /status: failed/);
    assert.match(result.stdout, /exit 7/);
  } finally {
    cleanup();
  }
});
