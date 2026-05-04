import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateJobId,
  createJob,
  loadJob,
  updateJob,
  listJobs,
  deleteJob,
  jobsDir,
} from "../../plugins/opencode/scripts/lib/jobs.mjs";

function makeProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), "buddy-jobs-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("generateJobId returns a string with prefix job_ and is unique", () => {
  const a = generateJobId();
  const b = generateJobId();
  assert.match(a, /^job_/);
  assert.match(b, /^job_/);
  assert.notEqual(a, b);
});

test("jobsDir resolves under <projectDir>/.claudecode-buddy/opencode/jobs", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const path = jobsDir(dir);
    assert.ok(path.endsWith(".claudecode-buddy/opencode/jobs"),
      `expected suffix .claudecode-buddy/opencode/jobs, got ${path}`);
    assert.ok(path.startsWith(dir), `expected prefix ${dir}, got ${path}`);
  } finally {
    cleanup();
  }
});

test("createJob writes a JSON record to disk and returns the record", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, {
      kind: "run",
      model: "vendor/some-model",
      pid: 12345,
      summary: "fix the bug",
    });
    assert.match(job.id, /^job_/);
    assert.equal(job.kind, "run");
    assert.equal(job.model, "vendor/some-model");
    assert.equal(job.status, "running");
    assert.equal(job.pid, 12345);
    assert.equal(job.summary, "fix the bug");
    assert.match(job.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(job.finished_at, null);
    const written = JSON.parse(readFileSync(join(jobsDir(dir), `${job.id}.json`), "utf8"));
    assert.deepEqual(written, job);
  } finally {
    cleanup();
  }
});

test("loadJob reads a job record by id", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const created = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    const loaded = loadJob(dir, created.id);
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.value, created);
  } finally {
    cleanup();
  }
});

test("loadJob returns ok:false for an unknown id", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const loaded = loadJob(dir, "job_nonexistent");
    assert.equal(loaded.ok, false);
    assert.match(loaded.error, /not found/i);
  } finally {
    cleanup();
  }
});

test("updateJob merges fields and rewrites the record", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const created = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    const updated = updateJob(dir, created.id, { status: "completed", exit_code: 0, finished_at: new Date().toISOString() });
    assert.equal(updated.ok, true);
    assert.equal(updated.value.status, "completed");
    assert.equal(updated.value.exit_code, 0);
    assert.notEqual(updated.value.finished_at, null);
    assert.equal(updated.value.kind, "run");
    assert.equal(updated.value.model, "x/y");
    assert.equal(updated.value.id, created.id);
  } finally {
    cleanup();
  }
});

test("updateJob returns ok:false for an unknown id", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const r = updateJob(dir, "job_nonexistent", { status: "completed" });
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/i);
  } finally {
    cleanup();
  }
});

test("listJobs returns all job records sorted by started_at descending", async () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const a = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const b = createJob(dir, { kind: "run", model: "x/y", pid: 2 });
    await new Promise((r) => setTimeout(r, 5));
    const c = createJob(dir, { kind: "review", model: "x/y", pid: 3 });
    const list = listJobs(dir);
    assert.equal(list.ok, true);
    assert.equal(list.value.length, 3);
    assert.equal(list.value[0].id, c.id);
    assert.equal(list.value[1].id, b.id);
    assert.equal(list.value[2].id, a.id);
  } finally {
    cleanup();
  }
});

test("listJobs returns empty when jobsDir does not exist", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const list = listJobs(dir);
    assert.equal(list.ok, true);
    assert.deepEqual(list.value, []);
  } finally {
    cleanup();
  }
});

test("createJob creates the jobsDir if it does not exist (idempotent mkdir -p)", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    assert.equal(existsSync(jobsDir(dir)), false);
    createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    assert.equal(existsSync(jobsDir(dir)), true);
    createJob(dir, { kind: "run", model: "x/y", pid: 2 });
  } finally {
    cleanup();
  }
});

test("loadJob rejects malformed job ids (path-traversal defense)", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const cases = ["../etc/passwd", "job_../etc/passwd", "JOB_UPPER", "job with spaces", ""];
    for (const bad of cases) {
      const r = loadJob(dir, bad);
      assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
      assert.match(r.error, /invalid job id format/i);
    }
  } finally {
    cleanup();
  }
});

test("updateJob rejects malformed job ids", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const r = updateJob(dir, "../etc/passwd", { status: "completed" });
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid job id format/i);
  } finally {
    cleanup();
  }
});

test("loadJob returns ok:false with parse error when the record is corrupt", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    writeFileSync(join(jobsDir(dir), `${job.id}.json`), "{not valid json");
    const r = loadJob(dir, job.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /parse|json/i);
  } finally {
    cleanup();
  }
});

test("listJobs skips corrupt records and returns the rest", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const a = createJob(dir, { kind: "run", model: "x/y", pid: 1, summary: "good" });
    const b = createJob(dir, { kind: "run", model: "x/y", pid: 2, summary: "also good" });
    writeFileSync(join(jobsDir(dir), `${a.id}.json`), "{garbage");
    const list = listJobs(dir);
    assert.equal(list.ok, true);
    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].id, b.id);
  } finally {
    cleanup();
  }
});

test("listJobs ignores .tmp in-flight writes", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    writeFileSync(join(jobsDir(dir), `${job.id}.json.tmp.999.123`), JSON.stringify({}));
    const list = listJobs(dir);
    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].id, job.id);
  } finally {
    cleanup();
  }
});

test("updateJob with expectedStatus succeeds when status matches", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    const r = updateJob(dir, job.id, { status: "completed", exit_code: 0 }, { expectedStatus: "running" });
    assert.equal(r.ok, true);
    assert.equal(r.value.status, "completed");
  } finally {
    cleanup();
  }
});

test("updateJob with expectedStatus rejects when status changed (CAS)", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    updateJob(dir, job.id, { status: "cancelled", finished_at: new Date().toISOString() });
    const r = updateJob(dir, job.id, { status: "completed", exit_code: 0 }, { expectedStatus: "running" });
    assert.equal(r.ok, false);
    assert.match(r.error, /status changed/i);
    const after = loadJob(dir, job.id);
    assert.equal(after.value.status, "cancelled");
  } finally {
    cleanup();
  }
});

test("updateJob expectedStatus accepts an array of allowed statuses", () => {
  // Required for the supervisor's natural-finish path after the SessionEnd hook
  // has stamped the job "session-ended": the supervisor's exit_code is the
  // authoritative final value, and it must be allowed to overwrite the
  // session-ended marker. expectedStatus: ["running", "session-ended"] should
  // accept either pre-state.
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    updateJob(dir, job.id, { status: "session-ended" });
    const r = updateJob(dir, job.id, {
      status: "completed",
      exit_code: 0,
    }, { expectedStatus: ["running", "session-ended"] });
    assert.equal(r.ok, true, `array CAS must accept session-ended; got: ${r.error}`);
    assert.equal(r.value.status, "completed");
    assert.equal(r.value.exit_code, 0);
  } finally {
    cleanup();
  }
});

test("updateJob expectedStatus array rejects when status is not in the allowed set", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    updateJob(dir, job.id, { status: "cancelled", finished_at: new Date().toISOString() });
    const r = updateJob(dir, job.id, {
      status: "completed",
      exit_code: 0,
    }, { expectedStatus: ["running", "session-ended"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /status changed.*running\|session-ended.*found cancelled/i);
  } finally {
    cleanup();
  }
});

test("updateJob writes are atomic (no partial reads under interruption)", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    updateJob(dir, job.id, { status: "completed", exit_code: 0 });
    const entries = readdirSync(jobsDir(dir));
    const tmps = entries.filter((f) => f.includes(".tmp"));
    assert.equal(tmps.length, 0, `expected no .tmp leftover, found: ${tmps.join(", ")}`);
  } finally {
    cleanup();
  }
});

test("deleteJob removes the record file", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const job = createJob(dir, { kind: "run", model: "x/y", pid: 1 });
    const r = deleteJob(dir, job.id);
    assert.equal(r.ok, true);
    const after = loadJob(dir, job.id);
    assert.equal(after.ok, false);
    assert.match(after.error, /not found/i);
  } finally {
    cleanup();
  }
});

test("deleteJob returns ok:false for unknown id", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const r = deleteJob(dir, "job_nonexistent");
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/i);
  } finally {
    cleanup();
  }
});

test("deleteJob rejects malformed job ids", () => {
  const { dir, cleanup } = makeProjectDir();
  try {
    const r = deleteJob(dir, "../etc/passwd");
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid job id format/i);
  } finally {
    cleanup();
  }
});
