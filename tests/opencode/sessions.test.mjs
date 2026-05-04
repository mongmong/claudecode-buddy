import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  deriveSessionKey,
  detectGitBranch,
  currentSessionKey,
  sessionFilePath,
  sessionLockPath,
  loadSessionId,
  saveSessionId,
  deleteSessionId,
  listSessions,
  acquireSessionLock,
} from "../../plugins/opencode/scripts/lib/sessions.mjs";
import { makeTempRepo } from "./helpers.mjs";

// --- deriveSessionKey ---

test("deriveSessionKey: feature/plan-NNN-* → plan-NNN", () => {
  assert.equal(deriveSessionKey({ branch: "feature/plan-001-foo-bar", override: null }), "plan-001");
  assert.equal(deriveSessionKey({ branch: "feature/plan-002-review-session-continuity", override: null }), "plan-002");
  assert.equal(deriveSessionKey({ branch: "feature/plan-100-bigplan", override: null }), "plan-100");
});

test("deriveSessionKey: numbered plan with no trailing description still works", () => {
  assert.equal(deriveSessionKey({ branch: "feature/plan-005", override: null }), "plan-005");
});

test("deriveSessionKey: non-plan branch → branch-<sanitised>", () => {
  assert.equal(deriveSessionKey({ branch: "bugfix/cleanup-tests", override: null }), "branch-bugfix-cleanup-tests");
  assert.equal(deriveSessionKey({ branch: "chris-experiment", override: null }), "branch-chris-experiment");
  assert.equal(deriveSessionKey({ branch: "feature/PLAN-005_v2.beta", override: null }), "branch-feature-plan-005-v2-beta");
});

test("deriveSessionKey: empty / null branch → scratch", () => {
  assert.equal(deriveSessionKey({ branch: null, override: null }), "scratch");
  assert.equal(deriveSessionKey({ branch: "", override: null }), "scratch");
  assert.equal(deriveSessionKey({ branch: undefined, override: null }), "scratch");
});

test("deriveSessionKey: --session-key override always wins", () => {
  assert.equal(deriveSessionKey({ branch: "feature/plan-001-foo", override: "custom-label" }), "custom-label");
  assert.equal(deriveSessionKey({ branch: null, override: "scratch-work" }), "scratch-work");
  assert.equal(deriveSessionKey({ branch: "main", override: "Plan_001/V2" }), "plan-001-v2");
});

test("deriveSessionKey: override of empty string falls through to branch rule", () => {
  assert.equal(deriveSessionKey({ branch: "feature/plan-001-foo", override: "" }), "plan-001");
});

test("deriveSessionKey: override that sanitises to empty falls back to 'unnamed'", () => {
  assert.equal(deriveSessionKey({ branch: null, override: "!!!" }), "unnamed");
});

// --- detectGitBranch / currentSessionKey ---

function gitInit(dir, branch = "main") {
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir });
}

test("detectGitBranch: returns current branch in a git repo", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    gitInit(dir, "feature/plan-002-foo");
    assert.equal(detectGitBranch(dir), "feature/plan-002-foo");
  } finally { cleanup(); }
});

test("detectGitBranch: returns null outside a git repo", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    assert.equal(detectGitBranch(dir), null);
  } finally { cleanup(); }
});

test("detectGitBranch: returns null on detached HEAD", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    gitInit(dir);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", sha], { cwd: dir });
    assert.equal(detectGitBranch(dir), null);
  } finally { cleanup(); }
});

test("currentSessionKey: branch + no override → derived key", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    gitInit(dir, "feature/plan-002-foo");
    assert.equal(currentSessionKey({ cwd: dir, override: null }), "plan-002");
  } finally { cleanup(); }
});

test("currentSessionKey: outside git → scratch", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    assert.equal(currentSessionKey({ cwd: dir, override: null }), "scratch");
  } finally { cleanup(); }
});

test("currentSessionKey: override always wins", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    assert.equal(currentSessionKey({ cwd: dir, override: "custom" }), "custom");
  } finally { cleanup(); }
});

// --- sessionFilePath ---

test("sessionFilePath: composes <projectDir>/.claudecode-buddy/opencode/sessions/<key>-<role>-<sanitised-model>.session-id", () => {
  const path = sessionFilePath("/tmp/x", "plan-001", "review", "deepseek/deepseek-v4-pro");
  assert.equal(path, "/tmp/x/.claudecode-buddy/opencode/sessions/plan-001-review-deepseek-deepseek-v4-pro.session-id");
});

test("sessionFilePath: sanitises malicious key (path traversal defense)", () => {
  const path = sessionFilePath("/tmp/x", "../etc", "review", "vendor/m");
  assert.ok(!path.includes(".."), `expected sanitised path, got ${path}`);
});

test("sessionFilePath: handles model strings with slashes", () => {
  const path = sessionFilePath("/tmp/x", "scratch", "run", "volcengine-plan/glm-5.1");
  assert.equal(path, "/tmp/x/.claudecode-buddy/opencode/sessions/scratch-run-volcengine-plan-glm-5-1.session-id");
});

// --- loadSessionId / saveSessionId / deleteSessionId ---

test("loadSessionId: returns ok:true value:null when file does not exist", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r = loadSessionId(dir, "plan-001", "review", "vendor/m");
    assert.equal(r.ok, true);
    assert.equal(r.value, null);
  } finally { cleanup(); }
});

test("saveSessionId then loadSessionId round-trips", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const w = saveSessionId(dir, "plan-001", "review", "vendor/m", "ses_abc123");
    assert.equal(w.ok, true);
    const r = loadSessionId(dir, "plan-001", "review", "vendor/m");
    assert.equal(r.ok, true);
    assert.equal(r.value, "ses_abc123");
  } finally { cleanup(); }
});

test("saveSessionId trims whitespace from sessionId", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "plan-001", "review", "vendor/m", "  ses_abc123\n");
    const r = loadSessionId(dir, "plan-001", "review", "vendor/m");
    assert.equal(r.value, "ses_abc123");
  } finally { cleanup(); }
});

test("saveSessionId is atomic (no .tmp leftovers on success)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "plan-001", "review", "vendor/m", "ses_abc");
    const sessionsDir = join(dir, ".claudecode-buddy", "opencode", "sessions");
    const entries = readdirSync(sessionsDir);
    assert.equal(entries.filter((e) => e.includes(".tmp.")).length, 0,
      `expected no .tmp leftovers, got: ${entries.join(", ")}`);
  } finally { cleanup(); }
});

test("deleteSessionId: ok:true when file existed", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "plan-001", "review", "vendor/m", "ses_abc");
    const r = deleteSessionId(dir, "plan-001", "review", "vendor/m");
    assert.equal(r.ok, true);
    assert.equal(loadSessionId(dir, "plan-001", "review", "vendor/m").value, null);
  } finally { cleanup(); }
});

test("deleteSessionId: ok:true even when file did not exist (idempotent)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r = deleteSessionId(dir, "plan-001", "review", "vendor/m");
    assert.equal(r.ok, true);
  } finally { cleanup(); }
});

test("saveSessionId rejects empty sessionId", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r = saveSessionId(dir, "plan-001", "review", "vendor/m", "");
    assert.equal(r.ok, false);
    assert.match(r.error, /empty/i);
  } finally { cleanup(); }
});

test("saveSessionId rejects non-ses_ prefix (defense against passing wrong value)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r = saveSessionId(dir, "plan-001", "review", "vendor/m", "not-a-session-id");
    assert.equal(r.ok, false);
    assert.match(r.error, /must start with ses_/i);
  } finally { cleanup(); }
});

// --- listSessions ---

test("listSessions: returns empty array when sessions/ does not exist", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r = listSessions(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, []);
  } finally { cleanup(); }
});

test("listSessions: enumerates all .session-id files (sessionId + path + mtime only)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "plan-001", "review", "vendor/m1", "ses_a1");
    saveSessionId(dir, "plan-001", "run", "vendor/m1", "ses_b1");
    saveSessionId(dir, "plan-002", "review", "vendor/m2", "ses_c1");
    const r = listSessions(dir);
    assert.equal(r.ok, true);
    assert.equal(r.value.length, 3);
    const ids = r.value.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, ["ses_a1", "ses_b1", "ses_c1"]);
    for (const s of r.value) {
      assert.ok(s.path.includes(".session-id"), "path field set");
      assert.ok(s.mtimeMs > 0, "mtime field set");
    }
  } finally { cleanup(); }
});

test("listSessions: skips .tmp files, .lock dirs, and unparseable records", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "plan-001", "review", "vendor/m", "ses_valid");
    const sessionsDir = join(dir, ".claudecode-buddy", "opencode", "sessions");
    writeFileSync(join(sessionsDir, "plan-X.tmp.123.456"), "ses_intermediate");
    writeFileSync(join(sessionsDir, "garbage-noprefix.session-id"), "not-a-session");
    mkdirSync(join(sessionsDir, "plan-001-review-vendor-m.lock"), { recursive: true });
    const r = listSessions(dir);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].sessionId, "ses_valid");
  } finally { cleanup(); }
});

// --- acquireSessionLock ---

test("acquireSessionLock: succeeds when no prior lock", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const lock = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(lock.ok, true);
    assert.ok(typeof lock.release === "function");
    lock.release();
  } finally { cleanup(); }
});

test("acquireSessionLock: returns ok:false when already locked, with actionable recovery instructions", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const a = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(a.ok, true);
    const b = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(b.ok, false);
    assert.match(b.error, /locked.*another opencode dispatch/i);
    assert.match(b.error, /rm -rf/i, "error message must include the manual recovery command");
    a.release();
    const c = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(c.ok, true, "lock should be free after release");
    c.release();
  } finally { cleanup(); }
});

test("acquireSessionLock: release() is idempotent", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const lock = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    lock.release();
    lock.release(); // must not throw
    const next = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(next.ok, true);
    next.release();
  } finally { cleanup(); }
});

test("acquireSessionLock: any pre-existing lock surfaces the manual-rm hint (no auto-reclaim)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const sessionsDir = join(dir, ".claudecode-buddy", "opencode", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const stalePath = join(sessionsDir, "plan-001-review-vendor-m.lock");
    mkdirSync(stalePath);

    const r = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(r.ok, false, "any pre-existing lock must be treated as held; no auto-reclaim in v0.3.0");
    assert.match(r.error, /rm -rf/i);
  } finally { cleanup(); }
});

test("sessionLockPath: composes the .lock path alongside the .session-id path", () => {
  const sessionPath = sessionFilePath("/tmp/x", "plan-001", "review", "vendor/m");
  const lockPath = sessionLockPath("/tmp/x", "plan-001", "review", "vendor/m");
  assert.equal(lockPath, sessionPath.replace(/\.session-id$/, ".lock"));
});
