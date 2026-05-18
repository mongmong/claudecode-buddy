import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

export const JOB_ID_RE = /^job_[a-z0-9_]+$/;

export function jobsDir(projectDir) {
  return join(projectDir, ".claudecode-buddy", "codex", "jobs");
}

export function generateJobId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `job_${ts}_${rand}`;
}

export function jobPath(projectDir, id) {
  if (!JOB_ID_RE.test(id)) {
    throw new Error(`invalid job id format: ${JSON.stringify(id)}`);
  }
  return join(jobsDir(projectDir), `${id}.json`);
}

function writeJobAtomic(path, record) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
}

export function createJob(projectDir, fields) {
  mkdirSync(jobsDir(projectDir), { recursive: true });
  const id = generateJobId();
  const record = {
    id,
    kind: fields.kind ?? "run",
    model: fields.model ?? null,
    started_at: new Date().toISOString(),
    finished_at: null,
    status: "running",
    pid: fields.pid ?? null,
    pgid: fields.pgid ?? null,
    exit_code: null,
    stdout_path: fields.stdout_path ?? null,
    stderr_path: fields.stderr_path ?? null,
    events_path: fields.events_path ?? null,
    summary: fields.summary ?? "",
  };
  writeJobAtomic(jobPath(projectDir, id), record);
  return record;
}

export function loadJob(projectDir, id) {
  if (!JOB_ID_RE.test(id)) return fail(`invalid job id format: ${JSON.stringify(id)}`);
  const path = jobPath(projectDir, id);
  if (!existsSync(path)) return fail(`job ${id} not found at ${path}`);
  try {
    return ok(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    return fail(`failed to parse job record ${path}: ${err.message}`);
  }
}

export function updateJob(projectDir, id, patch, { expectedStatus = null } = {}) {
  const loaded = loadJob(projectDir, id);
  if (!loaded.ok) return loaded;
  if (expectedStatus !== null) {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!allowed.includes(loaded.value.status)) {
      return fail(`status changed: expected ${allowed.join("|")}, found ${loaded.value.status}`);
    }
  }
  const merged = { ...loaded.value, ...patch };
  writeJobAtomic(jobPath(projectDir, id), merged);
  return ok(merged);
}

export function listJobs(projectDir) {
  const dir = jobsDir(projectDir);
  if (!existsSync(dir)) return ok([]);
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
  const records = [];
  for (const entry of entries) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, entry), "utf8")));
    } catch {
      // Skip unparseable records — corrupt files shouldn't break listing.
    }
  }
  records.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return ok(records);
}

export function deleteJob(projectDir, id) {
  if (!JOB_ID_RE.test(id)) return fail(`invalid job id format: ${JSON.stringify(id)}`);
  const path = jobPath(projectDir, id);
  if (!existsSync(path)) return fail(`job ${id} not found`);
  rmSync(path);
  return ok(true);
}
