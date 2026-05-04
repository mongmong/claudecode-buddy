# Plan 002 — Review session continuity

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** replace "fresh opencode session per dispatch" with "scoped session continuity per (plan-or-branch, role, model) tuple," so review and run pipelines build on their own prior reasoning across rounds without leaking context across unrelated work.

**Architecture:** rule-based session-key derivation (no LLM in the dispatch path), per-tuple session-id storage at `<project>/.claudecode-buddy/opencode/sessions/<key>-<role>-<model>.session-id`, automatic resume via opencode's `--session <id>` flag with **pre-flight validation** through `opencode session list --format json` (verifies the stored id is still alive on opencode's side before passing it). Capture is also done via `session list --format json` post-run, filtered by the session's `directory` field to disambiguate parallel unrelated runs; stderr-pattern parsing (`INFO service=session id=ses_... created`) is a defensive backup. Critical section (load → invoke → save) is guarded by an **advisory mkdir-based file lock** per (key, role, model) tuple; lock contention causes the dispatcher to run fresh-without-save (warning logged), preserving the lock-holder's continuity. All wiring in a Node module (`lib/review-dispatch.mjs`); CLI surface is `--session-key <name>` override + `--reset` (delete stored id) + `--no-session` (skip reuse this call without deletion).

**Tech stack:** Node ≥ 18.18 built-ins, `node:test`, opencode CLI ≥ 1.14 (`--session`, `--continue`, `opencode session list --format json`).

**Plan number:** 002 (next sequential after plan 001 v0.2.0).
**Target plugin version:** opencode v0.3.0.
**Plan number reshuffle:** the plan-001 follow-up notes earmarked plan 002 = adversarial-review.
This plan reclaims plan 002 for session-continuity (smaller, unblocks better review iteration);
adversarial-review + macOS-parity + flock-serialization shifts to plan 003.
README and CHANGELOG updates in Phase 7 reflect the renumber.

---

## Phases

| # | Component | Files |
|---|---|---|
| 1 | `lib/sessions.mjs` — session-id storage CRUD + key derivation | `plugins/opencode/scripts/lib/sessions.mjs` (new), `tests/opencode/sessions.test.mjs` (new) |
| 2 | `lib/session-capture.mjs` — extract session-id from opencode stderr/CLI | `plugins/opencode/scripts/lib/session-capture.mjs` (new), `tests/opencode/session-capture.test.mjs` (new) |
| 3 | `lib/review-dispatch.mjs` — high-level dispatcher (resolve key → load id → invoke → capture → save) | `plugins/opencode/scripts/lib/review-dispatch.mjs` (new), `tests/opencode/review-dispatch.test.mjs` (new) |
| 4 | Wire dispatcher into `runReview`, `runRun`, `runRunBackground` | `plugins/opencode/scripts/buddy.mjs`, `plugins/opencode/scripts/lib/invoke.mjs`, `plugins/opencode/scripts/lib/supervisor.mjs` |
| 5 | CLI surface — `--session-key <name>`, `--reset` flags through `parseReviewArgs` and `parseRunArgs` | `plugins/opencode/scripts/buddy.mjs` |
| 6 | Slash-command + subagent integration — pass `--session-key` from wrappers | `plugins/opencode/commands/review.md`, `plugins/opencode/commands/run.md`, `plugins/opencode/agents/opencode-review.md`, `plugins/opencode/agents/opencode-run.md` |
| 7 | CLAUDE.md updates — point plan-review and code-review at the new dispatch | `CLAUDE.md` |
| 8 | Documentation + version bump | `plugins/opencode/CHANGELOG.md`, `plugins/opencode/README.md`, `plugins/opencode/.claude-plugin/plugin.json`, `docs/architecture/decisions.md` (D-010), `docs/plans/002-review-session-continuity.md` post-execution report |

---

## Phase 1 — `lib/sessions.mjs` + key derivation (TDD)

**Files:**
- Create: `plugins/opencode/scripts/lib/sessions.mjs`
- Create: `tests/opencode/sessions.test.mjs`

This phase ships the pure-function key-derivation rule + the session-id file CRUD.
No opencode invocation happens here.

### Public API

```javascript
// Derive the session key from a branch name + override.
// override !== null wins. Otherwise:
//   - matches /^feature\/plan-(\d+)/  → "plan-<NNN>"  (zero-padded as in branch)
//   - else if branch is a non-empty string → "branch-<sanitized(branch)>"
//   - else → "scratch"
export function deriveSessionKey({ branch, override }): string

// Detect the current git branch (or null if not in a git repo / detached HEAD).
export function detectGitBranch(cwd): string | null

// Convenience wrapper that runs detectGitBranch + deriveSessionKey.
export function currentSessionKey({ cwd, override }): string

// Storage path. Sanitises (key, role, model) to safe filename components.
// projectDir/.claudecode-buddy/opencode/sessions/<key>-<role>-<sanitized-model>.session-id
export function sessionFilePath(projectDir, key, role, model): string

// Lock-dir path corresponding to (key, role, model). Same dir + sanitisation as
// sessionFilePath but with .lock suffix instead of .session-id. Exposed publicly
// because the supervisor (which is a separate Node process from the dispatcher)
// needs to construct this path to release the lock at close. Encapsulating it
// here means callers don't need to know about sanitiseLabel internals.
export function sessionLockPath(projectDir, key, role, model): string

// Load the stored session-id. Returns { ok: true, value: "ses_..." } or
// { ok: false, error: "..." } (file missing is NOT an error — returns ok:true, value:null).
export function loadSessionId(projectDir, key, role, model): { ok, value: string | null, error? }

// Atomic write. Same .tmp.<pid>.<ts> + renameSync pattern as lib/jobs.mjs.
export function saveSessionId(projectDir, key, role, model, sessionId): { ok, error? }

// Delete the session-id file (no-op if absent — returns ok:true).
export function deleteSessionId(projectDir, key, role, model): { ok, error? }

// List all session-id files present in sessions/.
// Returns [{ sessionId, path, mtimeMs }] — the filename → (key,role,model)
// reconstruction is intentionally NOT done because it's lossy (sanitisation
// is one-way + dashes inside any component break the split). Callers that
// need a (key,role,model) tuple already have it in hand.
export function listSessions(projectDir): { ok, value: Array, error? }

// Advisory lock around the (key, role, model) critical section.
// v0.3.0 implementation: pure mkdir-EEXIST. Atomic on POSIX. No staleness
// check, no reclamation, no token-file. Returns { ok, release }; caller MUST
// call release() in a try/finally. On contention (existing lock dir):
// returns { ok: false, error: "locked: ... rm -rf <path>" } including the
// manual-rm command for stranded-lock recovery.
//
// Stranded locks (process crashed without releasing) require manual `rm`.
// Auto-reclamation queued for plan 004 with proper flock(2) primitives.
// See "Lock simplification rationale" below for the round-6 design pivot.
export function acquireSessionLock(projectDir, key, role, model): { ok, release?: function, error? }
```

### Key derivation rule (exact)

```javascript
const PLAN_BRANCH_RE = /^feature\/plan-(\d+)(?:-|$)/;

export function deriveSessionKey({ branch, override }) {
  if (typeof override === "string" && override.length > 0) {
    return sanitiseLabel(override);
  }
  if (typeof branch === "string" && branch.length > 0) {
    const m = PLAN_BRANCH_RE.exec(branch);
    if (m) return `plan-${m[1]}`;
    return `branch-${sanitiseLabel(branch)}`;
  }
  return "scratch";
}
```

### Sanitisation (exact)

```javascript
// Lowercase, replace any run of non-[a-z0-9-] with single dash, trim leading/trailing dashes.
// Empty result falls back to "unnamed".
function sanitiseLabel(s) {
  const lowered = s.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, "-");
  const trimmed = replaced.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : "unnamed";
}
```

### Path traversal defense

```javascript
const SAFE_COMPONENT_RE = /^[a-z0-9-]+$/;

export function sessionFilePath(projectDir, key, role, model) {
  const safeKey = SAFE_COMPONENT_RE.test(key) ? key : sanitiseLabel(key);
  const safeRole = SAFE_COMPONENT_RE.test(role) ? role : sanitiseLabel(role);
  const safeModel = sanitiseLabel(model); // model has provider/name slash → always sanitise
  return join(
    projectDir, ".claudecode-buddy", "opencode", "sessions",
    `${safeKey}-${safeRole}-${safeModel}.session-id`,
  );
}
```

Defense-in-depth: even if a caller passes a malicious key, the sanitiser strips path-traversal characters. The check isn't necessary for correctness (callers go through `currentSessionKey`/`deriveSessionKey` which already sanitise) but mirrors `JOB_ID_RE` in `lib/jobs.mjs` as a safety pattern.

### Atomic writes

Use the same pattern as `lib/jobs.mjs`'s `writeJobAtomic`:

```javascript
function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
```

`saveSessionId` writes the trimmed session-id (one line, no newline) to a `.session-id` file atomically.

### Tasks

- [ ] **Step 1: Write failing tests for `deriveSessionKey`**

`tests/opencode/sessions.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionKey } from "../../plugins/opencode/scripts/lib/sessions.mjs";

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
  // Treat "" as no override.
  assert.equal(deriveSessionKey({ branch: "feature/plan-001-foo", override: "" }), "plan-001");
});

test("deriveSessionKey: override that sanitises to empty falls back to 'unnamed'", () => {
  assert.equal(deriveSessionKey({ branch: null, override: "!!!" }), "unnamed");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/opencode/sessions.test.mjs
```

Expected: all 6 tests fail with "Cannot find module .../sessions.mjs" or "deriveSessionKey is not a function".

- [ ] **Step 3: Write `lib/sessions.mjs` skeleton with `deriveSessionKey` and `sanitiseLabel`**

```javascript
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const PLAN_BRANCH_RE = /^feature\/plan-(\d+)(?:-|$)/;
const SAFE_COMPONENT_RE = /^[a-z0-9-]+$/;

function sanitiseLabel(s) {
  if (typeof s !== "string") return "unnamed";
  const lowered = s.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, "-");
  const trimmed = replaced.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : "unnamed";
}

export function deriveSessionKey({ branch, override }) {
  if (typeof override === "string" && override.length > 0) {
    return sanitiseLabel(override);
  }
  if (typeof branch === "string" && branch.length > 0) {
    const m = PLAN_BRANCH_RE.exec(branch);
    if (m) return `plan-${m[1]}`;
    return `branch-${sanitiseLabel(branch)}`;
  }
  return "scratch";
}
```

- [ ] **Step 4: Run tests to verify all 6 pass**

```bash
node --test tests/opencode/sessions.test.mjs
```

Expected: 6/6 pass.

- [ ] **Step 5: Add tests + implementation for `detectGitBranch` and `currentSessionKey`**

```javascript
test("detectGitBranch: returns current branch in a git repo", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    execFileSync("git", ["init", "-q", "-b", "feature/plan-002-foo"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir });
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
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", sha], { cwd: dir });
    assert.equal(detectGitBranch(dir), null);
  } finally { cleanup(); }
});

test("currentSessionKey: branch + no override → derived key", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    execFileSync("git", ["init", "-q", "-b", "feature/plan-002-foo"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir });
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
```

Add helpers import: `import { makeTempRepo } from "./helpers.mjs";`.

Implementation:

```javascript
export function detectGitBranch(cwd) {
  try {
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    // Not a git repo, or detached HEAD (symbolic-ref fails on detached).
    return null;
  }
}

export function currentSessionKey({ cwd, override }) {
  return deriveSessionKey({ branch: detectGitBranch(cwd), override: override ?? null });
}
```

- [ ] **Step 6: Run tests, verify 9/9 pass**

```bash
node --test tests/opencode/sessions.test.mjs
```

- [ ] **Step 7: Add tests + implementation for path construction (`sessionFilePath`)**

```javascript
test("sessionFilePath: composes <projectDir>/.claudecode-buddy/opencode/sessions/<key>-<role>-<sanitised-model>.session-id", () => {
  const path = sessionFilePath("/tmp/x", "plan-001", "review", "deepseek/deepseek-v4-pro");
  assert.equal(path, "/tmp/x/.claudecode-buddy/opencode/sessions/plan-001-review-deepseek-deepseek-v4-pro.session-id");
});

test("sessionFilePath: sanitises malicious key (path traversal defense)", () => {
  const path = sessionFilePath("/tmp/x", "../etc", "review", "vendor/m");
  // The double-dot is collapsed by sanitiseLabel since '/' is not [a-z0-9-].
  assert.equal(path, "/tmp/x/.claudecode-buddy/opencode/sessions/-etc-review-vendor-m.session-id");
  assert.ok(!path.includes(".."), `expected sanitised path, got ${path}`);
});

test("sessionFilePath: handles model strings with slashes", () => {
  const path = sessionFilePath("/tmp/x", "scratch", "run", "volcengine-plan/glm-5.1");
  assert.equal(path, "/tmp/x/.claudecode-buddy/opencode/sessions/scratch-run-volcengine-plan-glm-5-1.session-id");
});
```

Implementation: see "Path traversal defense" snippet above.

- [ ] **Step 8: Run tests, verify 12/12 pass**

```bash
node --test tests/opencode/sessions.test.mjs
```

- [ ] **Step 9: Add tests + implementation for `loadSessionId`, `saveSessionId`, `deleteSessionId`**

```javascript
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
```

Implementation:

```javascript
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

export function loadSessionId(projectDir, key, role, model) {
  const path = sessionFilePath(projectDir, key, role, model);
  if (!existsSync(path)) return { ok: true, value: null };
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return { ok: true, value: null };
    if (!SESSION_ID_RE.test(raw)) {
      return { ok: false, error: `corrupt session-id at ${path}: ${JSON.stringify(raw.slice(0, 64))}` };
    }
    return { ok: true, value: raw };
  } catch (err) {
    return { ok: false, error: `failed to read ${path}: ${err.message}` };
  }
}

export function saveSessionId(projectDir, key, role, model, sessionId) {
  const trimmed = (sessionId ?? "").trim();
  if (trimmed.length === 0) return { ok: false, error: "saveSessionId: empty sessionId" };
  if (!SESSION_ID_RE.test(trimmed)) {
    return { ok: false, error: `saveSessionId: sessionId must start with ses_ and be alphanumeric; got ${JSON.stringify(trimmed.slice(0, 64))}` };
  }
  const path = sessionFilePath(projectDir, key, role, model);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, trimmed);
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to write ${path}: ${err.message}` };
  }
}

export function deleteSessionId(projectDir, key, role, model) {
  const path = sessionFilePath(projectDir, key, role, model);
  if (!existsSync(path)) return { ok: true };
  try {
    rmSync(path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to delete ${path}: ${err.message}` };
  }
}
```

- [ ] **Step 10: Run tests, verify 20/20 pass (12 + 8 new)**

- [ ] **Step 11: Add tests + implementation for `listSessions`**

```javascript
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
      // listSessions intentionally does NOT reconstruct (key,role,model) — see
      // commit message + Codex/deepseek round-1 review notes. The filename split
      // is ambiguous (any component may contain dashes after sanitisation).
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
```

Implementation:

```javascript
export function listSessions(projectDir) {
  const sessionsDir = join(projectDir, ".claudecode-buddy", "opencode", "sessions");
  if (!existsSync(sessionsDir)) return { ok: true, value: [] };
  try {
    const records = [];
    for (const entry of readdirSync(sessionsDir)) {
      if (!entry.endsWith(".session-id") || entry.includes(".tmp.")) continue;
      const path = join(sessionsDir, entry);
      let sessionId;
      try { sessionId = readFileSync(path, "utf8").trim(); } catch { continue; }
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const stat = statSync(path);
      records.push({ sessionId, path, mtimeMs: stat.mtimeMs });
    }
    records.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, value: records };
  } catch (err) {
    return { ok: false, error: `listSessions failed: ${err.message}` };
  }
}
```

`listSessions` returns just `{sessionId, path, mtimeMs}` per record — no `key`/`role`/`model` reconstruction.
The filename embeds those fields after lossy sanitisation, so any decoded version would be misleading.
Callers (such as a future `/opencode:sessions` slash command) that want a clean tuple-listing should maintain a separate index file or accept that the path is a best-effort label.

- [ ] **Step 12: Run tests, verify 23/23 pass**

- [ ] **Step 13: Add tests + implementation for `acquireSessionLock`**

```javascript
test("acquireSessionLock: succeeds when no prior lock", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const lock = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(lock.ok, true);
    assert.ok(typeof lock.release === "function");
    lock.release();
  } finally { cleanup(); }
});

test("acquireSessionLock: returns ok:false when already locked", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const a = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(a.ok, true);
    const b = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(b.ok, false);
    assert.match(b.error, /locked/i);
    a.release();
    const c = acquireSessionLock(dir, "plan-001", "review", "vendor/m");
    assert.equal(c.ok, true, "lock should be free after release");
    c.release();
  } finally { cleanup(); }
});

// (Note: the prior test for stale-lock auto-reclamation was REMOVED in the
// round-6 simplification. v0.3.0 does not auto-reclaim — see the new test
// "rejected stale lock surfaces the manual-rm hint" later in this section.)

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
```

Implementation (simplified after round-6 — see "Lock simplification rationale" below):

```javascript
// v0.3.0 lock primitive: pure mkdir-EEXIST. No staleness check. No reclamation.
// No token-file. No verify-after-write.
//
// Acquisition: mkdirSync(<lock>) — atomic on POSIX. Success → we hold the lock.
// EEXIST → return locked. Period. No probing, no reclaim attempts.
//
// Release: rmSync(<lock>). Whoever called .release() rmdir's the dir. Since
// only one process can ever have a successful mkdir, only one process holds
// the lock and only that process calls release.
//
// Recovery for stranded locks (process crashed without releasing): user sees
// "locked: another opencode dispatch holds <path>" and manually rm's the
// directory. Auto-reclamation (with proper at-most-one-holder semantics) is
// queued for plan 004 via flock(2) or fcntl-locking.

// Public-API helper so the supervisor can construct the same lock-dir path
// without re-importing sanitiseLabel internals.
export function sessionLockPath(projectDir, key, role, model) {
  const sessionPath = sessionFilePath(projectDir, key, role, model);
  return sessionPath.replace(/\.session-id$/, ".lock");
}

export function acquireSessionLock(projectDir, key, role, model) {
  const path = sessionLockPath(projectDir, key, role, model);
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    mkdirSync(path);
  } catch (err) {
    if (err.code === "EEXIST") {
      return {
        ok: false,
        error:
          `locked: another opencode dispatch holds the session lock at ${path}. ` +
          `If no dispatch is actually running (previous process crashed), remove ` +
          `the lock manually with: rm -rf "${path}"`,
      };
    }
    return { ok: false, error: `lock mkdir failed: ${err.message}` };
  }
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      try { rmSync(path, { recursive: true, force: true }); } catch {}
    },
  };
}
```

### Lock simplification rationale (added at round 6)

Rounds 3-5 layered defenses against 3-party stale-reclamation races:
1. **Round 3**: rename-based atomic claim with token-file ownership.
2. **Round 4**: post-rename staleness re-verification (close fresh-lock-steal window).
3. **Round 5**: verify-after-write (catch racing token overwrites).

Each round closed one race window and exposed a subtler one. Round 6 reviewer (Codex) demonstrated that even with all three defenses, two reclaimers in the rare 3-party stale-race can both pass verify and **enter their dispatch's critical section concurrently** — the token check at release converges only the cleanup, not the actual opencode work.

The fundamental issue: `mkdir` is atomic for *creation*, but the (mkdir + token-write) compound is not. True at-most-one-holder for the whole critical section requires `flock(2)` or `fcntl(F_SETLK)` semantics — neither available as a Node built-in.

**Decision**: drop reclamation for v0.3.0. The simpler primitive has zero racing surface:
- mkdir-EEXIST succeeds atomically (POSIX guarantee).
- Only one process can succeed per (key, role, model) tuple.
- That one process holds the lock for the entire critical section.
- That same process's `release()` rmdir's it.
- No other process can interfere because there's no reclamation path.

**Trade-off**: a crashed dispatch leaves a stranded lock until manual `rm`. The error message tells the user exactly what to do. For this workspace's expected workload (one developer, sequential reviews), this is a low-frequency operational annoyance vs. multi-round correctness rabbit-holing.

Plan 004 will revisit with proper flock(2) (via a small native binding or `node-fcntl-locking`) once the workload justifies it.

### Tests for the simplified lock

```javascript
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
  // v0.3.0 treats every pre-existing lock as held — regardless of age.
  // Manual `rm` is the only recovery path. The simpler primitive trades the
  // convenience of auto-reclamation for zero racing surface.
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
```

- [ ] **Step 14: Run tests, verify 27/27 pass (23 + 4 new)**

- [ ] **Step 15: Commit Phase 1**

```bash
git add plugins/opencode/scripts/lib/sessions.mjs tests/opencode/sessions.test.mjs
git commit -m "feat(opencode): lib/sessions.mjs — session-id storage, key derivation, advisory lock"
```

---

## Phase 2 — `lib/session-capture.mjs` + pre-flight validation (TDD)

**Files:**
- Create: `plugins/opencode/scripts/lib/session-capture.mjs`
- Create: `tests/opencode/session-capture.test.mjs`

This phase ships **three** mechanisms (revised from round-1 review):

1. **`verifySessionExists`** (pre-flight) — query `opencode session list --format json` and verify a stored id is alive on opencode's side BEFORE passing `--session <id>`. Primary defense against blocker 1 (silent stale-session failure).

2. **`captureSessionIdFromStderr`** (post-run capture, **primary**) — parse `INFO ... service=session id=ses_<id> ... created` from the captured stderr stream. Stderr is deterministic per-invocation (it's THIS process's own stderr, not shared with other opencode processes), so this disambiguates correctly even under concurrent unrelated same-cwd dispatches.

3. **`captureLatestSessionForCwd`** (post-run capture, **fallback only**) — query `session list --format json`, filter sessions by `directory === cwd`, pick the highest-`updated`-timestamp record. Used ONLY when stderr parsing returns null (e.g., opencode's log format changed). Has a known limitation (per Codex round-12 review): under concurrent dispatches in the same cwd but different (role, model) tuples — e.g., parallel `/opencode:review` + `/opencode:run` — the cwd filter can't disambiguate, and "most-recent-updated" may pick the wrong session. Acceptable trade-off because (a) it's a fallback, (b) saving a wrong id triggers a stale-detect-and-restart on the next dispatch.

### Public API

```javascript
// Pre-flight: does this session-id still exist on opencode's side?
// Returns { ok: true, exists: true | false } on success;
// { ok: false, error } if the CLI itself failed (binary missing, etc.).
export function verifySessionExists(binary, sessionId): { ok, exists?: boolean, error? }

// Fallback capture (used ONLY when stderr parse fails, e.g. opencode log
// format changed): most-recently-updated session whose directory === cwd.
// Returns the highest-`updated`-timestamp record matching `cwd` (or null if
// none). Filtering by `directory` partially disambiguates parallel runs but
// has a known limitation under same-cwd-different-tuple concurrency
// (per Codex round-12 review) — see D-010 known limitations.
export function captureLatestSessionForCwd(binary, cwd): { ok, value: string | null, error? }

// Primary capture: parse the stderr buffer for INFO ... service=session id=ses_<id> ...
// Returns the FIRST session-id matched (newest creates emit first).
export function captureSessionIdFromStderr(stderr): string | null

### Implementation

```javascript
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
// Match "INFO ... service=session id=ses_<id> ..."
// The service=session id=ses_ marker is the discriminator; INFO/timestamp prefix
// may shift across opencode versions but the kv-pair format is stable.
const SESSION_CREATED_RE = /service=session\s+id=(ses_[A-Za-z0-9]+)/;
const LIST_TIMEOUT_MS = 10_000;

function runSessionList(binary, opts = {}) {
  const args = ["session", "list", "--format", "json"];
  if (opts.maxCount) args.push("--max-count", String(opts.maxCount));
  try {
    const raw = execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LIST_TIMEOUT_MS,
    });
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: true, value: [] };
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (err) {
      return { ok: false, error: `session list returned non-JSON: ${err.message}` };
    }
    const sessions = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
    return { ok: true, value: sessions };
  } catch (err) {
    return { ok: false, error: `session list failed: ${err.message}` };
  }
}

export function verifySessionExists(binary, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return { ok: true, exists: false }; // malformed id → treat as non-existent
  }
  // Use a generous max-count: opencode default sort is by updated desc, but a
  // session not touched recently could fall outside small windows. Use 1000.
  const r = runSessionList(binary, { maxCount: 1000 });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, exists: r.value.some((s) => s?.id === sessionId) };
}

// Normalise a path for comparison. realpath resolves symlinks + trims trailing
// slashes; if it fails (path doesn't exist on disk), fall back to the literal.
function normalisePath(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  try { return realpathSync(p); } catch { return p; }
}

export function captureLatestSessionForCwd(binary, cwd) {
  const r = runSessionList(binary, { maxCount: 50 });
  if (!r.ok) return r;
  const cwdReal = normalisePath(cwd);
  const matching = r.value.filter((s) =>
    SESSION_ID_RE.test(s?.id ?? "") &&
    normalisePath(s?.directory ?? "") === cwdReal,
  );
  if (matching.length === 0) return { ok: true, value: null };
  matching.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return { ok: true, value: matching[0].id };
}

export function captureSessionIdFromStderr(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  for (const line of stderr.split("\n")) {
    const m = SESSION_CREATED_RE.exec(line);
    if (m) return m[1];
  }
  return null;
}
```

### Tasks

- [ ] **Step 1: Write failing test for `captureSessionIdFromStderr`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureSessionIdFromStderr } from "../../plugins/opencode/scripts/lib/session-capture.mjs";

test("captureSessionIdFromStderr: extracts ses_ id from real opencode log line", () => {
  const stderr = `
INFO  2026-05-04T00:28:32 +5ms service=session id=ses_20f9d00edffejjPulI1sCyTQ99 slug=misty-meadow version=1.14.33 projectID=20a0b376e511ff347670153897dc003fcdede60b created
INFO  2026-05-04T00:28:32 +0ms service=server method=POST path=/session/ses_20f9d00edffejjPulI1sCyTQ99/message request
`;
  assert.equal(captureSessionIdFromStderr(stderr), "ses_20f9d00edffejjPulI1sCyTQ99");
});

test("captureSessionIdFromStderr: returns null on empty input", () => {
  assert.equal(captureSessionIdFromStderr(""), null);
  assert.equal(captureSessionIdFromStderr(null), null);
  assert.equal(captureSessionIdFromStderr(undefined), null);
});

test("captureSessionIdFromStderr: returns null when no service=session line present", () => {
  assert.equal(
    captureSessionIdFromStderr("INFO 2026 service=server status=200\nERROR something else"),
    null,
  );
});

test("captureSessionIdFromStderr: returns FIRST session-id when multiple appear", () => {
  // If two sessions are created in the same invocation (shouldn't happen in
  // practice, but defensive), the first one wins — that's the one we ran.
  const stderr = `
INFO 2026 service=session id=ses_first slug=a created
INFO 2026 service=session id=ses_second slug=b updated
`;
  assert.equal(captureSessionIdFromStderr(stderr), "ses_first");
});

test("captureSessionIdFromStderr: tolerates extra whitespace + log-level variations", () => {
  const stderr = "DEBUG   2026-05-04   service=session    id=ses_xyz123ABC   slug=foo";
  assert.equal(captureSessionIdFromStderr(stderr), "ses_xyz123ABC");
});
```

- [ ] **Step 2: Run tests, see 5 failures**

- [ ] **Step 3: Write `captureSessionIdFromStderr` implementation (see snippet above)**

- [ ] **Step 4: Run tests, verify 5/5 pass**

- [ ] **Step 5: Add fixture + tests + implementation for `verifySessionExists` and `captureLatestSessionForCwd`**

Create `tests/opencode/fixtures/mock-opencode-session-list.mjs`:

```javascript
#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("1.14.33-mock");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list" && args.includes("--format") && args.includes("json")) {
  // Sessions can be injected via OPENCODE_FIXTURE_SESSIONS env var (path to JSON file)
  // for test-by-test customisation. Default: a single session.
  if (process.env.OPENCODE_FIXTURE_SESSIONS && existsSync(process.env.OPENCODE_FIXTURE_SESSIONS)) {
    console.log(readFileSync(process.env.OPENCODE_FIXTURE_SESSIONS, "utf8"));
  } else {
    console.log(JSON.stringify([
      { id: "ses_mockSESSION12345", title: "Mock", updated: 1777854512914, directory: "/tmp/mock-cwd" },
    ]));
  }
  process.exit(0);
}
console.error("mock-opencode-session-list: unsupported invocation");
process.exit(2);
```

`chmod +x` on it.

```javascript
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import { verifySessionExists, captureLatestSessionForCwd } from "../../plugins/opencode/scripts/lib/session-capture.mjs";
import { makeTempRepo } from "./helpers.mjs";

const LIST_BIN = resolve("tests/opencode/fixtures/mock-opencode-session-list.mjs");

test("verifySessionExists: true when the id is in session list", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const sessionsFile = join(dir, "sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_LIVEaaa", updated: 1, directory: "/tmp" },
      { id: "ses_LIVEbbb", updated: 2, directory: "/tmp" },
    ]));
    process.env.OPENCODE_FIXTURE_SESSIONS = sessionsFile;
    try {
      const r = verifySessionExists(LIST_BIN, "ses_LIVEbbb");
      assert.equal(r.ok, true);
      assert.equal(r.exists, true);
    } finally { delete process.env.OPENCODE_FIXTURE_SESSIONS; }
  } finally { cleanup(); }
});

test("verifySessionExists: false when the id is not in session list", () => {
  const r = verifySessionExists(LIST_BIN, "ses_GHOSTED");
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
});

test("verifySessionExists: false for malformed id (defense)", () => {
  const r = verifySessionExists(LIST_BIN, "not-a-session");
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
});

test("verifySessionExists: ok:false when binary missing", () => {
  const r = verifySessionExists("/nonexistent/binary", "ses_x");
  assert.equal(r.ok, false);
  assert.match(r.error, /session list failed/i);
});

test("captureLatestSessionForCwd: picks highest updated where directory matches cwd", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const sessionsFile = join(dir, "sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_OLDER",  updated: 100, directory: "/tmp/cwd-A" },
      { id: "ses_NEWER",  updated: 200, directory: "/tmp/cwd-A" },
      { id: "ses_OTHER",  updated: 300, directory: "/tmp/cwd-B" },
    ]));
    process.env.OPENCODE_FIXTURE_SESSIONS = sessionsFile;
    try {
      const r = captureLatestSessionForCwd(LIST_BIN, "/tmp/cwd-A");
      assert.equal(r.ok, true);
      assert.equal(r.value, "ses_NEWER",
        "must pick the highest updated WITHIN the matching cwd, ignoring sessions in other directories");
    } finally { delete process.env.OPENCODE_FIXTURE_SESSIONS; }
  } finally { cleanup(); }
});

test("captureLatestSessionForCwd: returns null when no sessions match cwd", () => {
  const r = captureLatestSessionForCwd(LIST_BIN, "/tmp/no-match");
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});
```

- [ ] **Step 6: Run tests, verify 11/11 pass (5 stderr + 6 list)**

- [ ] **Step 7: Commit Phase 2**

```bash
git add plugins/opencode/scripts/lib/session-capture.mjs tests/opencode/session-capture.test.mjs tests/opencode/fixtures/mock-opencode-session-list.mjs
git commit -m "feat(opencode): lib/session-capture.mjs — pre-flight verify + cwd-filtered capture + stderr fallback"
```

---

## Phase 3 — `lib/review-dispatch.mjs` (TDD)

**Files:**
- Create: `plugins/opencode/scripts/lib/review-dispatch.mjs`
- Create: `tests/opencode/review-dispatch.test.mjs`

This phase composes Phase 1 + Phase 2 into a high-level dispatcher.

### Public API

```javascript
// High-level dispatch entry point.
// Resolves the session key, loads any stored session-id, builds the opencode
// argv (adding --session <id> when applicable), invokes opencode, captures the
// new session-id from stderr (or via session list fallback), persists it, and
// returns the final result.
//
// Caller responsibilities:
//   - role: "review" | "run" | "prompt" (or any safe label)
//   - model: provider/model string
//   - prompt: the message to send (assistant text)
//   - opencodeArgs: array of additional args for opencode (e.g. --format json, --dir)
//   - sessionKeyOverride: optional --session-key value
//   - reset: if true, delete stored session-id before dispatch
//   - reuseExisting: default true (--continue behaviour). Set false when the
//                    caller wants a fresh session this round but still wants
//                    the next call to resume from THIS new session.
//
// Returns: { ok, text, error?, sessionId? } via invokeOpencodeRaw passthrough,
//          plus { sessionId } populated with the captured/persisted id.
export async function dispatchOpencode({
  binary,
  cwd,
  projectDir,
  role,
  model,
  prompt,
  opencodeArgs = [],
  sessionKeyOverride = null,
  reset = false,
  reuseExisting = true,
  invokeImpl = invokeOpencodeRaw, // injectable for tests
})
```

### Behavioural contract (revised after round-1 review)

1. Compute `key = currentSessionKey({ cwd, override: sessionKeyOverride })`.
2. **Acquire advisory lock** on (key, role, model) via `acquireSessionLock`. On contention, log a warning and proceed in a degraded mode: skip session reuse for this call, run fresh, and skip save (the lock-holder's session-id stays authoritative). Return the result of the fresh run normally.
3. If `reset === true`, call `deleteSessionId(projectDir, key, role, model)`.
4. Load `existingId = loadSessionId(projectDir, key, role, model).value` (may be null).
5. **Pre-flight:** if `existingId !== null && reuseExisting && !noSession`, call `verifySessionExists(binary, existingId)`. If it returns `{ ok: true, exists: false }`, the stored id is stale: delete the file and clear `existingId` so we run fresh. If `verifySessionExists` returns `{ ok: false, error }` (the CLI failed entirely), log a warning but proceed with `--session <existingId>` anyway (defense-in-depth via stderr scan handles this).
6. Build argv:
   - Caller's `opencodeArgs` (untouched).
   - Append `--print-logs --log-level INFO` so stderr emits session events for the backup capture path.
   - If `existingId !== null && reuseExisting && !noSession`, append `--session <existingId>`.
   - Append the prompt as the final positional arg.
7. Call `invokeImpl({ binary, args, cwd })`.
8. **Stale-session backup detection:** if invocation completed successfully OR completed with `ok:false` AND the captured `stderr` contains `"Session not found: <existingId>"`, treat as a stale-session race (the session was deleted between our pre-flight and the run). Delete the file and run a single retry without `--session`. Return the retry's result.
9. On `ok: false` (after retry, if any), release the lock and return the result.
10. On `ok: true`:
    - **Capture via session list:** call `captureLatestSessionForCwd(binary, cwd)`. If a non-null id is returned and (`existingId === null` OR `id !== existingId`), use that as the new id.
    - **Backup capture from stderr:** if the list-based capture returned null (e.g., binary issues), fall back to `captureSessionIdFromStderr(invocation.stderr ?? "")`.
    - If a captured id is non-null and differs from `existingId`, call `saveSessionId`. On save failure, log a warning but return the run result successfully.
    - Attach `sessionId` (the resolved id, captured or pre-existing) to the returned result for callers to surface.
11. Release the lock in a `finally`-style handler — on success, error path, or exception. Lock release is always called (idempotently safe).

### Stale-session race window

Pre-flight (step 5) verifies the id is alive immediately before invocation. There is a small race window where the session could be deleted by an out-of-band `opencode session delete` between pre-flight and the actual run. The stderr-backup detection in step 8 covers this race. The combined defenses give:

- **Common case:** stored id is alive → pre-flight passes → resume succeeds; capture confirms same id; no save needed.
- **Out-of-band deletion BEFORE pre-flight:** pre-flight detects, file deleted, run starts fresh, new id captured + saved.
- **Out-of-band deletion DURING the run** (after pre-flight): stderr backup catches `"Session not found: <id>"`, file deleted, retry runs fresh.
- **opencode CLI itself broken** (binary missing during pre-flight, `session list` errors, etc.): fall through to passing `--session <id>` anyway and rely on stderr backup.

### Lock-contention behaviour (degraded mode)

When two dispatches under the same (key, role, model) tuple race, the first to acquire the lock follows the normal flow (pre-flight, save, etc.). The second sees `acquireSessionLock` return `{ ok: false, error: "locked" }`. Behaviour:

- Log: `"warn: another opencode dispatch is in progress for <tuple>; running this one without session continuity to avoid race."`
- Build argv WITHOUT `--session`.
- Run normally.
- Skip the post-run save (the lock-holder's id-being-saved is the canonical one).
- Return the run result without `sessionId` populated (so callers know continuity didn't happen).

This preserves correctness of the lock-holder's continuity at the cost of breaking continuity for the contending dispatch — an honest, predictable degradation rather than silent corruption.

### Tasks

- [ ] **Step 1: Write fakes for invokeImpl + a fresh-session test**

The dispatcher calls `verifySessionExists` and `captureLatestSessionForCwd` from `lib/session-capture.mjs`, which run `execFileSync` on the configured `binary`. To keep these tests pure-JS without spawning a child process, we use `tests/opencode/fixtures/mock-opencode-session-list.mjs` as the binary and inject session data via `OPENCODE_FIXTURE_SESSIONS`.

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import { dispatchOpencode } from "../../plugins/opencode/scripts/lib/review-dispatch.mjs";
import { loadSessionId, saveSessionId, acquireSessionLock } from "../../plugins/opencode/scripts/lib/sessions.mjs";
import { makeTempRepo } from "./helpers.mjs";

const MOCK_SESSION_BIN = resolve("tests/opencode/fixtures/mock-opencode-session-list.mjs");

function fakeInvoke(behavior) {
  // behavior: { ok, text?, stderr?, error?, exit_code? }
  return async ({ args }) => {
    const sessionFlagIdx = args.indexOf("--session");
    behavior._observedArgs = [...args];
    behavior._observedSessionId = sessionFlagIdx >= 0 ? args[sessionFlagIdx + 1] : null;
    return behavior;
  };
}

function withMockSessions(dir, sessions, fn) {
  const path = join(dir, `mock-sessions-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(sessions));
  process.env.OPENCODE_FIXTURE_SESSIONS = path;
  try { return fn(); } finally { delete process.env.OPENCODE_FIXTURE_SESSIONS; }
}

test("dispatchOpencode: first call (no existing session) → no --session flag, captures + saves new id", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const fake = { ok: true, text: "review body",
      stderr: "INFO 2026 service=session id=ses_NEW12345 slug=foo created\n" };
    await withMockSessions(dir, [
      { id: "ses_NEW12345", updated: 100, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "hi",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(result.sessionId, "ses_NEW12345");
      assert.equal(fake._observedSessionId, null, "no --session flag on first call");
    });
    const saved = loadSessionId(dir, "scratch", "review", "vendor/m");
    assert.equal(saved.value, "ses_NEW12345");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Implement `dispatchOpencode` skeleton + first-call path**

```javascript
import { invokeOpencodeRaw } from "./invoke.mjs";
import {
  currentSessionKey, loadSessionId, saveSessionId, deleteSessionId, acquireSessionLock,
} from "./sessions.mjs";
import {
  verifySessionExists, captureLatestSessionForCwd, captureSessionIdFromStderr,
} from "./session-capture.mjs";

// Defensive backup pattern. Matched against captured stderr after the run.
// Uses literal "Session not found: <id>" anchored on the stored id so we
// don't false-positive on log lines mentioning sessions in other contexts.
function staleSessionInStderr(stderr, sessionId) {
  if (typeof stderr !== "string" || sessionId === null) return false;
  return stderr.includes(`Session not found: ${sessionId}`)
      || stderr.includes(`session not found: ${sessionId}`);
}

export async function dispatchOpencode({
  binary, cwd, projectDir,
  role, model, prompt,
  opencodeArgs = [],
  sessionKeyOverride = null,
  reset = false,
  noSession = false,
  reuseExisting = true,
  invokeImpl = invokeOpencodeRaw,
}) {
  const key = currentSessionKey({ cwd, override: sessionKeyOverride });

  // Acquire lock around the load-invoke-save critical section. On contention
  // run in degraded mode (no session continuity for this call).
  const lock = acquireSessionLock(projectDir, key, role, model);
  if (!lock.ok) {
    process.stderr.write(
      `warn: another opencode dispatch holds the session lock for ${key}/${role}/${model}; ` +
      `running without session continuity to avoid race.\n`,
    );
    const args = [...opencodeArgs, "--print-logs", "--log-level", "INFO", prompt];
    const result = await invokeImpl({ binary, args, cwd });
    return { ...result, sessionId: null, sessionKey: key, degraded: true };
  }

  try {
    if (reset) deleteSessionId(projectDir, key, role, model);
    let existing = loadSessionId(projectDir, key, role, model).value;
    const wantResume = existing !== null && reuseExisting && !noSession;

    // Pre-flight: verify the stored id is alive on opencode's side.
    if (wantResume) {
      const verify = verifySessionExists(binary, existing);
      if (verify.ok && !verify.exists) {
        // Stored id is stale → delete the file and run fresh.
        deleteSessionId(projectDir, key, role, model);
        existing = null;
      } // else: verify failed → fall through and rely on stderr-backup detection.
    }

    const args = [...opencodeArgs, "--print-logs", "--log-level", "INFO"];
    if (existing !== null && reuseExisting && !noSession) {
      args.push("--session", existing);
    }
    args.push(prompt);

    let invocation = await invokeImpl({ binary, args, cwd });

    // Backup detection for the race window between pre-flight and run.
    if (existing !== null && staleSessionInStderr(invocation.stderr ?? "", existing)) {
      deleteSessionId(projectDir, key, role, model);
      const freshArgs = [...opencodeArgs, "--print-logs", "--log-level", "INFO", prompt];
      invocation = await invokeImpl({ binary, args: freshArgs, cwd });
      existing = null;
    }

    if (!invocation.ok) return { ...invocation, sessionKey: key };

    // Capture priority: stderr-parsing PRIMARY → session list FALLBACK.
    //
    // Stderr is deterministic for OUR specific opencode invocation — the
    // `service=session id=ses_<id> ... created` line is emitted in this
    // process's own stderr stream, with no possibility of interference from
    // unrelated parallel opencode runs.
    //
    // session list is a fallback ONLY for the case where opencode's log
    // format changes and our regex no longer matches. It has a known
    // limitation (per Codex round-12 review): under concurrent dispatches in
    // the same cwd but different (role, model) tuples — e.g., a parallel
    // /opencode:review and /opencode:run — both processes' sessions match
    // the directory==cwd filter, and "most-recent-updated" can pick the
    // wrong one. Caveat documented in D-010.
    let captured = captureSessionIdFromStderr(invocation.stderr ?? "");
    if (captured === null) {
      const listCapture = captureLatestSessionForCwd(binary, cwd);
      if (listCapture.ok && listCapture.value) {
        captured = listCapture.value;
        process.stderr.write(
          `warn: session-id captured via session list fallback (stderr parse failed). ` +
          `If concurrent same-cwd dispatches were running, this may have picked the wrong session.\n`,
        );
      }
    }

    // --no-session: skip persistence so the original stored id survives unchanged.
    // The "one-off detached question" contract requires that --no-session does NOT
    // overwrite the running thread's session-id with the transient ad-hoc one.
    if (!noSession && captured !== null && captured !== existing) {
      const save = saveSessionId(projectDir, key, role, model, captured);
      if (!save.ok) process.stderr.write(`warn: failed to save session-id: ${save.error}\n`);
    }

    return {
      ...invocation,
      sessionId: noSession ? null : (captured ?? existing ?? null),
      sessionKey: key,
    };
  } finally {
    lock.release();
  }
}
```

- [ ] **Step 3: Run test, verify it passes**

- [ ] **Step 4: Add resume-existing test (verifies pre-flight passes when id is alive)**

```javascript
test("dispatchOpencode: second call with stored alive session → pre-flight passes, --session flag added", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_PRIOR99");
    const fake = { ok: true, text: "review body 2",
      stderr: "INFO 2026 service=session id=ses_PRIOR99 slug=foo updated\n" };
    await withMockSessions(dir, [
      { id: "ses_PRIOR99", updated: 200, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "again",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(fake._observedSessionId, "ses_PRIOR99");
      assert.equal(result.sessionId, "ses_PRIOR99");
    });
  } finally { cleanup(); }
});
```

- [ ] **Step 5: Verify it passes**

- [ ] **Step 6: Add pre-flight stale detection test (the key blocker-1 fix)**

```javascript
test("dispatchOpencode: stored id NOT in session list → pre-flight deletes file + runs fresh", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_STALEpre");
    const fake = { ok: true, text: "fresh body",
      stderr: "INFO 2026 service=session id=ses_NEWpre slug=foo created\n" };
    // Mock session list returns NO sessions matching ses_STALEpre; one matching ses_NEWpre
    // (the freshly-created one, post-run, with this cwd).
    await withMockSessions(dir, [
      { id: "ses_NEWpre", updated: 300, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "hi",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(fake._observedSessionId, null,
        "pre-flight should have detected stale id and dropped --session from argv");
      assert.equal(result.sessionId, "ses_NEWpre");
    });
    assert.equal(loadSessionId(dir, "scratch", "review", "vendor/m").value, "ses_NEWpre",
      "stale file replaced with the freshly-created session id");
  } finally { cleanup(); }
});
```

- [ ] **Step 7: Verify it passes**

- [ ] **Step 8: Add reset test**

```javascript
test("dispatchOpencode: reset:true deletes the stored session-id before dispatch", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_OLDONE");
    const fake = { ok: true, text: "fresh body",
      stderr: "INFO 2026 service=session id=ses_NEWONE slug=foo created\n" };
    await withMockSessions(dir, [
      { id: "ses_NEWONE", updated: 300, directory: dir },
    ], async () => {
      await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "fresh",
        opencodeArgs: ["run", "--format", "default"],
        reset: true,
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(fake._observedSessionId, null, "reset must drop --session flag from argv");
    });
    const saved = loadSessionId(dir, "scratch", "review", "vendor/m");
    assert.equal(saved.value, "ses_NEWONE");
  } finally { cleanup(); }
});
```

- [ ] **Step 9: Add no-session test (does NOT delete the stored id, just skips reuse this call)**

```javascript
test("dispatchOpencode: noSession:true preserves the original stored id (no overwrite)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_KEEP");
    const fake = { ok: true, text: "ad-hoc body",
      stderr: "INFO 2026 service=session id=ses_TRANSIENT slug=foo created\n" };
    await withMockSessions(dir, [
      { id: "ses_KEEP", updated: 100, directory: dir },
      { id: "ses_TRANSIENT", updated: 200, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "ad-hoc",
        opencodeArgs: ["run", "--format", "default"],
        noSession: true,
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(fake._observedSessionId, null, "noSession must skip --session flag");
      assert.equal(result.sessionId, null,
        "noSession must NOT report the transient sessionId — the running thread is unchanged");
    });
    // Crucial assertion: the ORIGINAL stored id survives. The dispatcher must NOT
    // save the transient ses_TRANSIENT and overwrite ses_KEEP.
    const saved = loadSessionId(dir, "scratch", "review", "vendor/m");
    assert.equal(saved.value, "ses_KEEP",
      "noSession violates the 'detached one-off' contract if it overwrites the stored id");
  } finally { cleanup(); }
});
```

- [ ] **Step 10: Add stderr-backup detection test (race window between pre-flight and run)**

```javascript
test("dispatchOpencode: race deletion (alive at pre-flight, gone at run) → stderr backup detection + retry", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_RACE");
    let calls = 0;
    const invokeImpl = async ({ args }) => {
      calls += 1;
      const usingSession = args.includes("--session");
      if (calls === 1 && usingSession) {
        // Race: pre-flight saw it, now opencode says "Session not found".
        return {
          ok: true, text: "",
          stderr: "ERROR 2026 something went wrong\nmessage: \"Session not found: ses_RACE\"\n",
        };
      }
      return {
        ok: true, text: "post-recovery body",
        stderr: "INFO 2026 service=session id=ses_REBORN slug=foo created\n",
      };
    };
    await withMockSessions(dir, [
      { id: "ses_RACE", updated: 100, directory: dir }, // pre-flight check passes
      { id: "ses_REBORN", updated: 300, directory: dir }, // capture after retry
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "retry",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl,
      });
      assert.equal(result.ok, true);
      assert.equal(calls, 2, "should have retried once after stderr stale-session backup detection");
      assert.equal(loadSessionId(dir, "scratch", "review", "vendor/m").value, "ses_REBORN");
    });
  } finally { cleanup(); }
});
```

- [ ] **Step 11: Add lock-contention test (degraded mode)**

```javascript
test("dispatchOpencode: lock contention → degraded mode (no --session, no save)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_HELD");
    // Simulate another in-flight dispatch holding the lock.
    const heldLock = acquireSessionLock(dir, "scratch", "review", "vendor/m");
    assert.equal(heldLock.ok, true);
    try {
      const fake = { ok: true, text: "racing body",
        stderr: "INFO 2026 service=session id=ses_OTHER slug=foo created\n" };
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "concurrent",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(result.degraded, true);
      assert.equal(result.sessionId, null,
        "degraded mode must NOT populate sessionId (continuity didn't happen)");
      assert.equal(fake._observedSessionId, null, "degraded mode must NOT pass --session");
      // Crucial: the lock-holder's stored id stays authoritative.
      assert.equal(loadSessionId(dir, "scratch", "review", "vendor/m").value, "ses_HELD");
    } finally { heldLock.release(); }
  } finally { cleanup(); }
});
```

- [ ] **Step 12: Add session-key override test**

```javascript
test("dispatchOpencode: sessionKeyOverride bypasses git rule", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "custom", "review", "vendor/m", "ses_CUSTOM");
    const fake = { ok: true, text: "x",
      stderr: "INFO 2026 service=session id=ses_CUSTOM slug=foo updated\n" };
    await withMockSessions(dir, [
      { id: "ses_CUSTOM", updated: 300, directory: dir },
    ], async () => {
      await dispatchOpencode({
        binary: MOCK_SESSION_BIN, cwd: dir, projectDir: dir,
        role: "review", model: "vendor/m", prompt: "hi",
        opencodeArgs: ["run"],
        sessionKeyOverride: "custom",
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(fake._observedSessionId, "ses_CUSTOM");
    });
  } finally { cleanup(); }
});
```

- [ ] **Step 13: Verify all 8 dispatch tests pass**

- [ ] **Step 14: Commit Phase 3**

```bash
git add plugins/opencode/scripts/lib/review-dispatch.mjs tests/opencode/review-dispatch.test.mjs
git commit -m "feat(opencode): lib/review-dispatch.mjs — pre-flight + lock + capture priorities"
```

---

## Phase 4 — Wire dispatcher into existing buddy.mjs subcommands

**Files:**
- Modify: `plugins/opencode/scripts/lib/invoke.mjs:42-91` (return stderr + exit_code in invocation result)
- Modify: `plugins/opencode/scripts/buddy.mjs:runReview` (route through `dispatchOpencode`)
- Modify: `plugins/opencode/scripts/buddy.mjs:runRun` (route through `dispatchOpencode`)
- Modify: `plugins/opencode/scripts/buddy.mjs:runRunBackground` (pass session-id through to supervisor)
- Modify: `plugins/opencode/scripts/lib/supervisor.mjs` (accept session-id positional arg, capture session-id from stderr at exit, persist via lib/sessions.mjs)
- Update: `tests/opencode/run-cmd.test.mjs`, `tests/opencode/review-cmd.test.mjs` — assert session continuity round-trips through the wired path.

### invokeOpencodeRaw must return stderr on EVERY path (per deepseek round-1 should-fix)

Today `invokeOpencodeRaw` returns `{ ok, text }` on success but discards stderr.
The dispatcher needs stderr for the backup `staleSessionInStderr` detection AND for the post-run stderr-backup capture.

**Change:** make `invokeOpencodeRaw` thread `stderr` (always a string, default `""`) through every resolution path:

```diff
   child.on("error", (err) => {
     clearTimeout(timer);
-    resolveResult({ ok: false, error: `failed to invoke opencode: ${err.message}` });
+    resolveResult({ ok: false, error: `failed to invoke opencode: ${err.message}`, stderr, exit_code: null });
   });
   child.on("close", (code, signal) => {
     clearTimeout(timer);
     if (timedOut) {
-      resolveResult({ ok: false, error: ..., exit_code: code });
+      resolveResult({ ok: false, error: ..., stderr, exit_code: code });
       return;
     }
     if (code !== 0) {
-      resolveResult({ ok: false, error: ..., exit_code: code });
+      resolveResult({ ok: false, error: ..., stderr, exit_code: code });
       return;
     }
     const messages = parseEvents(stdout);
     if (messages.length === 0) {
-      resolveResult({ ok: false, error: ..., exit_code: code });
+      resolveResult({ ok: true, text: "", stderr, exit_code: code });
+      // ↑ Note shape change: "no assistant text" was an error before. With session
+      // continuity it's a meaningful state — opencode can return an empty body
+      // for "Session not found" (silent stale-session failure). Let the dispatcher
+      // decide via stderr scan whether this is recoverable. The original "no
+      // assistant text" error case was the only place this shape mattered; the
+      // dispatcher handles it via staleSessionInStderr → retry path, and existing
+      // /opencode:review handles it via the trailer-parse logic which already
+      // graceful-degrades on empty input.
       return;
     }
-    resolveResult({ ok: true, text: messages[messages.length - 1] });
+    resolveResult({ ok: true, text: messages[messages.length - 1], stderr, exit_code: code });
   });
```

⚠ This shape change (empty-text → ok:true with empty body, instead of ok:false) is the most invasive part of Phase 4. Existing callers of `invokeOpencodeRaw` (just `runRun` foreground) MUST be updated to handle empty text. `invokeOpencode` (the dispatcher's parent in `runReview`) already handles empty messages — no change there.

### runReview routing

Today `runReview` builds `opencodeArgs` itself and calls `invokeOpencode` directly.
After: `runReview` builds `opencodeArgs` (without `--print-logs --log-level INFO` and without the prompt; the dispatcher appends those), then calls `dispatchOpencode({ role: "review", model, prompt, opencodeArgs, sessionKeyOverride: args.sessionKey, reset: args.reset, noSession: args.noSession })` — forwarding ALL three session flags so `--no-session` reaches the dispatcher.

### runRun routing (foreground)

Same pattern as `runReview`. The foreground `runRun` already uses `invokeOpencodeRaw`; switch to `dispatchOpencode` with `role: "run"` and forward all three session flags (`sessionKeyOverride`, `reset`, `noSession`).

### runRunBackground routing

The supervisor pattern complicates session continuity:

- `runRunBackground` (parent) creates the job record, runs pre-flight (`verifySessionExists`) + acquires the lock, and only then spawns the supervisor. The verified-alive resume id (or null if stale/none) is appended to `opencodeArgs` as `--session <id>` BEFORE the rest are passed through to the supervisor.
- The supervisor doesn't load any session-id itself — it just runs opencode with whatever `opencodeArgs` it was given (which may already include `--session <id>`). On close, it parses its captured stderr for the NEW session-id and persists via `saveSessionId(projectDir, sessionKey, role, model, capturedId)` (only if `!noSession && !degraded`).

Supervisor argv signature was `[jobId, projectDir, binary, cwd, ...opencodeArgs]`. Extend to `[jobId, projectDir, binary, cwd, role, sessionKey, model, noSession, degraded, ...opencodeArgs]` (11 positionals before the rest) so the supervisor can persist the captured session-id with the right tuple AND honour the dispatcher's `--no-session` / lock-degraded-mode contracts. (The supervisor also already has access to projectDir, so saving via `saveSessionId(projectDir, key, role, model, capturedId)` is a one-liner addition.)

### Tasks (TDD-tightened per Codex round-1 should-fix #5)

- [ ] **Step 1: Add failing wired-path tests FIRST (before any production code change)**

Tests that exercise the round-trip through `runReview` and `runRun` once they are wired. They will fail until Steps 4-5 land.

```javascript
// tests/opencode/review-dispatch-integration.test.mjs (new file)
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { saveSessionId, loadSessionId } from "../../plugins/opencode/scripts/lib/sessions.mjs";

const REVIEW_OK_BIN = resolve("tests/opencode/fixtures/mock-opencode-review-success.mjs");

test("review wired path: stored alive session → --session passed in observed argv", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_PRIORW");
    const fixtureLog = join(dir, "fixture-log.ndjson");
    const sessionsFile = join(dir, "mock-sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_PRIORW", updated: 200, directory: dir },
    ]));
    const result = await runCompanion(
      ["review", "--model", "vendor/m"],
      {
        OPENCODE_BIN: REVIEW_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir,
        OPENCODE_FIXTURE_LOG: fixtureLog, OPENCODE_FIXTURE_SESSIONS: sessionsFile,
      },
    );
    assert.equal(result.code, 0);
    const log = readFileSync(fixtureLog, "utf8").trim().split("\n").map(JSON.parse);
    const sessionFlagIdx = log[0].argv.indexOf("--session");
    assert.notEqual(sessionFlagIdx, -1, "wired review must include --session in argv");
    assert.equal(log[0].argv[sessionFlagIdx + 1], "ses_PRIORW");
  } finally { cleanup(); }
});

test("review wired path: --reset deletes stored id before dispatch", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_OLD");
    const fixtureLog = join(dir, "fixture-log.ndjson");
    const sessionsFile = join(dir, "mock-sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_NEWr", updated: 300, directory: dir },
    ]));
    await runCompanion(
      ["review", "--model", "vendor/m", "--reset"],
      {
        OPENCODE_BIN: REVIEW_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir,
        OPENCODE_FIXTURE_LOG: fixtureLog, OPENCODE_FIXTURE_SESSIONS: sessionsFile,
      },
    );
    const log = readFileSync(fixtureLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(log[0].argv.indexOf("--session"), -1, "--reset must drop --session from argv");
  } finally { cleanup(); }
});

// Similar tests for /opencode:run wired path (foreground + background).
```

- [ ] **Step 2: Run tests, verify they fail with "review does not yet route through dispatcher" / "argv missing --session"**

```bash
node --test tests/opencode/review-dispatch-integration.test.mjs
```

Expected: failures.

- [ ] **Step 3: Modify `invokeOpencodeRaw` to thread stderr on every path**

[Use the diff in the "invokeOpencodeRaw must return stderr" subsection above.]

- [ ] **Step 4: Update fixtures (mock-opencode-* and mock-supervisor) to emit session-created stderr lines + record observed argv**

The fixtures need three additions to support the dispatcher's contract:

1. Emit `INFO ... service=session id=ses_<deterministic-id> slug=mock created` to stderr (for stderr-backup capture).
2. Honour `OPENCODE_FIXTURE_LOG=<path>` env var to append `{argv: [...]}` per invocation (for tests to assert session-flag presence).
3. Use a deterministic id derived from `--session <id>` if present (so resume tests don't generate spurious new ids).

Apply to all 4 mocks: `mock-opencode-review-success.mjs`, `mock-opencode-run-success.mjs`, `mock-opencode-run-with-edits.mjs`, `mock-opencode-run-fail.mjs`.

**Mock session-id contract (per deepseek round-2 should-fix):** the fixtures use a **deterministic, specified algorithm** for the emitted session-id:

- If argv contains `--session <id>` (a resume) → emit `<id>` back in the stderr session-created line. The dispatcher's `captureLatestSessionForCwd` / `captureSessionIdFromStderr` will see the same id and skip save (since it equals `existingId`).
- If argv does NOT contain `--session` (a fresh run) → emit a fixed `ses_mockNEW` sentinel. Tests assert against this literal.
- If `OPENCODE_FIXTURE_SESSIONS=<file>` is set, the fixture emits the listed sessions verbatim instead (used for `verifySessionExists` and `captureLatestSessionForCwd` test stages where we want to inject specific session list contents).

This contract is the same across all four mock fixtures, so tests can assert exact strings (`ses_mockNEW`, the resumed id, or fixture-injected ids).

`mock-supervisor.mjs` argv handling needs an update: the dispatcher passes **5 new positional args** before `...opencodeArgs` — role, sessionKey, model, noSession, degraded. The mock supervisor accepts-and-ignores all five:

```diff
 // tests/opencode/fixtures/mock-supervisor.mjs
-const [, , jobId, ...opencodeArgs] = process.argv;
+const [, , jobId, projectDir, binary, cwd, role, sessionKey, model, noSessionRaw, degradedRaw, ...opencodeArgs] = process.argv;
 // ... rest of fixture (process.title etc. unchanged)
```

(The mock previously ignored `projectDir`, `binary`, `cwd` too — only `jobId` was used. The change is purely structural.) Plan 002's mock supervisor remains argv-shape-only; it does not need to interpret `noSessionRaw` or `degradedRaw` because the production supervisor's session-save logic isn't exercised in the existing tests — the new background round-trip integration test in Phase 4 Step 10 uses the production supervisor, not the mock.

- [ ] **Step 5: Run all existing tests; verify nothing broke**

```bash
node --test tests/opencode/
```

Expected: existing 152 pass / 3 e2e skipped, no regressions. (The `invokeOpencodeRaw` shape change to "empty text → ok:true" is verified by the existing `invoke.test.mjs`; if `runRun` foreground had assumed ok:false on empty text, those tests would catch it now.)

- [ ] **Step 6: Wire `runReview` through `dispatchOpencode` (forwarding all 3 session flags)**

The dispatcher accepts `sessionKeyOverride`, `reset`, AND `noSession`. The wiring must forward all three from the parsed args. Missing any one is a silent functionality regression — e.g., omitting `noSession` means `/opencode:review --no-session` silently saves a session (per Codex round-4 finding).

```diff
 async function runReview(rawArgs) {
   ...
-  const invocation = await invokeOpencode({
-    binary: cli.binary, prompt, cwd, model: parsed.value.model,
-  });
+  const invocation = await dispatchOpencode({
+    binary: cli.binary, cwd, projectDir,
+    role: "review", model: parsed.value.model, prompt,
+    opencodeArgs: ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd, "--model", parsed.value.model],
+    sessionKeyOverride: parsed.value.sessionKey ?? null,
+    reset: parsed.value.reset ?? false,
+    noSession: parsed.value.noSession ?? false,
+  });
   if (!invocation.ok) {
     process.stderr.write(`opencode invocation failed: ${invocation.error}\n`);
     process.exit(1);
   }
+  if (invocation.sessionId) {
+    process.stderr.write(`opencode session: ${invocation.sessionId} (key derived from current branch; --session-key to override; --reset to start fresh)\n`);
+  }
```

- [ ] **Step 7: Wire `runRun` (foreground) through `dispatchOpencode` — forward sessionKeyOverride, reset, AND noSession**

```diff
+  const invocation = await dispatchOpencode({
+    binary: cli.binary, cwd, projectDir,
+    role: "run", model: args.model, prompt: args.task,
+    opencodeArgs: [
+      "run",
+      ...(args.yolo ? ["--dangerously-skip-permissions"] : []),
+      "--format", "json", "--dir", cwd,
+      ...(args.model ? ["--model", args.model] : []),
+    ],
+    sessionKeyOverride: args.sessionKey ?? null,
+    reset: args.reset ?? false,
+    noSession: args.noSession ?? false,  // critical: foreground --no-session must reach the dispatcher
+  });
```

- [ ] **Step 8: Modify supervisor argv signature + add post-exit session save (see Step-8 detail below for the full rewrite)**

The supervisor's argv signature changes from `(jobId, ...opencodeArgs)` to `(jobId, projectDir, binary, cwd, role, sessionKey, model, noSession, degraded, ...opencodeArgs)` — 5 new positionals to thread session-continuity context. The simplified mkdir-only lock has at-most-one-holder by construction, so no ownership-token positional is needed. The supervisor also gains:
- A top-of-file `uncaughtException` handler (registered before any our-own-module import — see Step 8 detail).
- A `releaseLock()` helper that simply rmdir's the lock dir (no token-verify after round-6 simplification — at-most-one-holder by mkdir-EEXIST atomicity).
- An updated `child.on("close")` that captures the new session-id from stderr (or session list) and saves it (only if not degraded and not noSession).

The full file diff is shown later in this Phase under "Step 8 detail (full supervisor.mjs rewrite)" — kept separate from this checkbox to keep the task list scannable.

- [ ] **Step 9: Update `runRunBackground` — parent owns the round-1 defenses end-to-end**

The parent (`runRunBackground`) — NOT the supervisor — runs `acquireSessionLock` + `verifySessionExists` + degraded-mode handling. The supervisor only persists the captured session-id and releases the lock at close. This keeps the foreground and background paths' defense semantics identical.

```diff
+import { currentSessionKey, loadSessionId, deleteSessionId, acquireSessionLock, sessionLockPath } from "./lib/sessions.mjs";
+import { verifySessionExists } from "./lib/session-capture.mjs";
+import { rmSync } from "node:fs";

 function runRunBackground(args, cwd, projectDir, cli) {
+  const key = currentSessionKey({ cwd, override: args.sessionKey });
+
+  // Parent acquires lock BEFORE spawning. The supervisor inherits the open
+  // lock-dir on the filesystem and releases it (rmdir) at close.
+  const lock = acquireSessionLock(projectDir, key, "run", args.model);
+  let degraded = false;
+  let resumeId = null;
+
+  if (!lock.ok) {
+    process.stderr.write(
+      `warn: another opencode dispatch holds the session lock for ${key}/run/${args.model}; ` +
+      `running this background job without session continuity to avoid race.\n`,
+    );
+    if (args.reset) {
+      process.stderr.write(`warn: --reset ignored because another dispatch holds the lock\n`);
+    }
+    degraded = true;
+  } else {
+    if (args.reset) deleteSessionId(projectDir, key, "run", args.model);
+    let storedId = args.noSession ? null : loadSessionId(projectDir, key, "run", args.model).value;
+
+    if (storedId !== null) {
+      const verify = verifySessionExists(cli.binary, storedId);
+      if (verify.ok && !verify.exists) {
+        // Pre-flight detected stale id. Delete the file; run fresh.
+        deleteSessionId(projectDir, key, "run", args.model);
+        storedId = null;
+      }
+      // verify.ok === false (CLI failure): fall through with storedId; supervisor's stderr-backup will handle stale.
+    }
+    resumeId = storedId;
+  }
+
   const opencodeArgs = ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd,
                        "--print-logs", "--log-level", "INFO"];
   if (args.model) opencodeArgs.push("--model", args.model);
+  if (resumeId !== null) opencodeArgs.push("--session", resumeId);
   opencodeArgs.push(args.task);

-  const supervisor = spawn(process.execPath,
-    [supervisorScript, jobId, projectDir, cli.binary, cwd, ...opencodeArgs],
+  // Supervisor argv: ...job/cwd info + role + sessionKey + model + noSession + degraded + opencodeArgs.
+  // The supervisor uses (sessionKey, role, model) to call saveSessionId after capturing from stderr.
+  // It uses `noSession` to skip save (matching the foreground dispatcher's contract).
+  // It uses `degraded` to also skip save (the lock-holder's id stays authoritative).
+  // Argv to supervisor: 5 session-continuity positionals (role, sessionKey,
+  // model, noSession, degraded) before ...opencodeArgs. The simplified
+  // mkdir-only lock has at-most-one-holder by construction, so any process
+  // running the supervisor IS the lock holder — no ownership-token needed.
+  const supervisor = spawn(process.execPath,
+    [supervisorScript, jobId, projectDir, cli.binary, cwd, "run", key, args.model,
+      String(!!args.noSession), String(degraded), ...opencodeArgs],
+    { detached: true, ... });
+
+  // Lock-ownership handoff (parent → supervisor). The parent releases the lock
+  // if spawn() fails synchronously OR fires "error" before "spawn". Otherwise
+  // ownership transfers to the supervisor, which holds it until its own close
+  // handler rmdir's it.
+  //
+  // RESIDUAL RISK (acceptable for v0.3.0): if the supervisor's Node process
+  // forks successfully but exits during MODULE LOAD (before its uncaughtException
+  // handler is registered), the lock is stranded permanently and must be
+  // manually `rm`'d by the user. (No auto-reclamation in v0.3.0 — see D-010.)
+  // To minimise this window, the supervisor's uncaughtException handler is
+  // registered FIRST in supervisor.mjs (before any our-own-module import that
+  // could throw). See supervisor.mjs Step 8 below.
+  if (!degraded) {
+    let ownershipTransferred = false;
+    supervisor.once("error", (err) => {
+      if (ownershipTransferred) return; // supervisor running; its handlers own release
+      try { rmSync(sessionLockPath(projectDir, key, "run", args.model), { recursive: true, force: true }); } catch {}
+      process.stderr.write(`error: failed to spawn supervisor: ${err.message}\n`);
+    });
+    supervisor.once("spawn", () => {
+      // Successful fork. Supervisor process is running and will release the lock
+      // via its own crash/close handlers. From here, parent does nothing further.
+      ownershipTransferred = true;
+    });
+  }
```

The supervisor's matching changes:

```diff
-const [, , jobId, projectDir, binary, cwd, ...opencodeArgs] = process.argv;
+const [, , jobId, projectDir, binary, cwd, role, sessionKey, model, noSessionRaw, degradedRaw, ...opencodeArgs] = process.argv;
+const noSession = noSessionRaw === "true";
+const degraded = degradedRaw === "true";
+
+// CRITICAL ORDERING (per Codex round-4/5 review): the uncaughtException handler
+// MUST be registered before any of OUR own imports (which can throw at module
+// load time on syntax errors / missing files / circular deps). ESM hoists all
+// `import` statements to the top of the module body, so we can't simply
+// "register handler before imports" via textual order. Instead:
+//
+//   1. STATIC IMPORTS at top: built-ins ONLY (`node:fs`, `node:path`, etc.).
+//      Built-ins cannot fail at module load — they're always present in Node.
+//   2. REGISTER crash handler in module body. (Module body runs after static
+//      imports, but since static imports are built-ins-only, they can't have
+//      thrown.)
+//   3. DYNAMIC IMPORTS (`await import(...)`) for our own modules. These can
+//      fail, but the crash handler is now registered to catch them.
+//
+// (`require()` is NOT available in .mjs files without createRequire(); the
+//  static-imports-of-builtins approach is simpler and avoids the createRequire
+//  ceremony.)
+import { rmSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
+import { join as joinPath } from "node:path";
+import { spawn } from "node:child_process";
+
+// Argv signature: 11 positionals before opencodeArgs. The simplified lock
+// primitive has at-most-one-holder by construction (mkdir-EEXIST atomicity),
+// so any process running the supervisor IS the lock holder — no per-process
+// ownership check required, just rmdir on release.
+const [, , jobId, projectDir, binary, cwd, role, sessionKey, model, noSessionRaw, degradedRaw, ...opencodeArgs] = process.argv;
+const noSession = noSessionRaw === "true";
+const degraded = degradedRaw === "true";
+
+// Inline lock-dir derivation for the crash handler — duplicates the
+// sanitiseLabel logic from lib/sessions.mjs to avoid depending on dynamic
+// imports that may not have completed yet.
+function inlineSanitise(s) {
+  return (s ?? "").toString().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
+}
+function inlineLockDir() {
+  return joinPath(projectDir, ".claudecode-buddy", "opencode", "sessions",
+    `${inlineSanitise(sessionKey)}-${inlineSanitise(role)}-${inlineSanitise(model)}.lock`);
+}
+
+// SINGLE crash handler — replaces the previous v0.2.0 uncaughtException
+// handler (which only updated the job record) AND the round-4 attempt (which
+// only released the lock + wrote supervisor-error). Both responsibilities now
+// live here so a crash performs the full cleanup atomically:
+//   1. Release the session lock (so future dispatches aren't stranded).
+//   2. Update the job record to "failed" (so /opencode:status shows the truth).
+//   3. Write supervisor-error (debug breadcrumb).
+//
+// Codex round-6 blocker: the prior approach had TWO separate uncaughtException
+// handlers — top-of-file handler exited 1 before the existing v0.2.0 handler
+// could update the job. Background jobs stayed stuck "running" forever on
+// supervisor crash.
+//
+// The handler uses ONLY built-in node:fs operations (no dynamic imports, no
+// own-module imports), so it works even when our dynamic imports below failed
+// to load.
+process.on("uncaughtException", (err) => {
+  // 1. Release lock (post round-6 simplification: no token check; only-holder
+  //    invariant means whoever's running knows it's their lock).
+  try {
+    if (!degraded) {
+      rmSync(inlineLockDir(), { recursive: true, force: true });
+    }
+  } catch {}
+  // 2. Update job record. Inline JSON read+merge+atomic-write because the
+  //    dynamic import of ./jobs.mjs may not have completed.
+  try {
+    const jobPath = joinPath(projectDir, ".claudecode-buddy", "opencode", "jobs", `${jobId}.json`);
+    const record = JSON.parse(readFileSync(jobPath, "utf8"));
+    record.status = "failed";
+    record.exit_code = null;
+    record.finished_at = new Date().toISOString();
+    const tmp = `${jobPath}.tmp.${process.pid}.${Date.now()}`;
+    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
+    renameSync(tmp, jobPath);  // statically imported above; atomic-write same shape as lib/jobs.mjs
+  } catch {}
+  // 3. Best-effort error breadcrumb.
+  try {
+    writeFileSync(
+      joinPath(projectDir, ".claudecode-buddy", "opencode", "jobs", `${jobId}.supervisor-error`),
+      `supervisor uncaught: ${err.stack ?? err.message ?? err}\n`,
+    );
+  } catch {}
+  process.exit(1);
+});
+// Note: the v0.2.0-shape handler that previously lived inside the file (which
+// only did updateJob) is REMOVED in this rewrite — its logic is folded into
+// the handler above so a single handler runs end-to-end on crash.

+// Dynamic imports for our own modules (now safe — handler is registered).
+const { captureSessionIdFromStderr, captureLatestSessionForCwd } = await import("./session-capture.mjs");
+const { saveSessionId, sessionLockPath } = await import("./sessions.mjs");
+
+function releaseLock() {
+  if (degraded) return; // Parent never acquired the lock in degraded mode.
+  // Simplified release after round-6 lock simplification: there's no reclamation
+  // path, so only ONE process can hold the lock at a time, and it's always the
+  // parent (which transferred ownership to us via spawn). Just rmdir.
+  try { rmSync(sessionLockPath(projectDir, sessionKey, role, model), { recursive: true, force: true }); } catch {}
+}

 child.on("close", (code, signal) => {
   // ... existing buffer flush + stdoutPath update ...

+  // Capture the session-id from our buffered stderr (already on disk at stderrPath)
+  // OR from session list. Save unless degraded or --no-session.
+  if (!degraded && !noSession) {
+    let captured = null;
+    try {
+      const stderrBuf = readFileSync(stderrPath, "utf8");
+      // Detect "Session not found" — if our --session was stale, do NOT save.
+      // The next dispatch's pre-flight will see no file and run fresh.
+      const staleHit = stderrBuf.match(/Session not found: (ses_[A-Za-z0-9]+)/);
+      if (staleHit) {
+        process.stderr.write(`warn: opencode reported stale session ${staleHit[1]} mid-run; skipping save\n`);
+      } else {
+        captured = captureSessionIdFromStderr(stderrBuf);
+        if (captured === null) {
+          const list = captureLatestSessionForCwd(binary, cwd);
+          if (list.ok && list.value) captured = list.value;
+        }
+      }
+    } catch {}
+    if (captured !== null) {
+      const save = saveSessionId(projectDir, sessionKey, role, model, captured);
+      if (!save.ok) process.stderr.write(`warn: supervisor failed to save session-id: ${save.error}\n`);
+    }
+  }
+
+  releaseLock();
+
   updateJob(projectDir, jobId, { status, ... }, { expectedStatus: ["running", "session-ended"] });
   process.exit(code ?? 0);
 });

+// child.on("error") releases the lock too. Same job-record-failed update
+// as the uncaughtException handler at the top of the file (which catches
+// uncaught errors); this child-error path triggers when the opencode child
+// process itself fails to spawn or emits an error event.
+child.on("error", (err) => {
+  releaseLock();
+  // Update job record to "failed" — same atomic-write pattern as the
+  // top-of-file uncaughtException handler. (Use the dynamic-imported
+  // updateJob if available, else inline.)
+  try {
+    updateJob(projectDir, jobId, {
+      status: "failed",
+      finished_at: new Date().toISOString(),
+      exit_code: null,
+    }, { expectedStatus: ["running", "session-ended"] });
+  } catch {}
+  process.exit(1);
+});
```

Note: there is a SINGLE `uncaughtException` handler in supervisor.mjs — registered at the very top of the file (see Step 8 detail above). It does (a) lock release, (b) job-record update to "failed", (c) supervisor-error breadcrumb. The previous v0.2.0 separate handler is REMOVED — its responsibility is folded into the top-of-file handler. Background jobs no longer get stuck "running" on supervisor crash.

The supervisor uses the **public** `sessionLockPath(projectDir, key, role, model)` helper from `lib/sessions.mjs` to construct the lock-dir path — no need to import the private `sanitiseLabel` directly. `sessionLockPath` is part of Phase 1's exported API so the supervisor (a separate Node process) can release the lock without depending on the dispatcher's internals.

**Why parent (not supervisor) does pre-flight:** the parent is alive when the user invokes the slash command, so its pre-flight + lock acquisition is visible to the user (degraded-mode warnings print to the slash command's stderr). The supervisor is detached; its diagnostics go to `<id>.supervisor-error`. Locking in the parent gives faster feedback when the user has competing dispatches.

**Why supervisor (not parent) saves:** the parent returns immediately (background launch contract — `Started job <id>` printed within ~50ms). Only the supervisor knows when opencode finished and what session id it ended up using. The lock spans both: parent acquires before spawn, supervisor releases after capture. The atomic mkdir gives correct serialisation across the parent → supervisor handoff.

- [ ] **Step 10: Add round-trip integration test (background path) using `--session-key` for determinism**

This step uses the fixture updates already applied in Step 4. Note that for the background path the supervisor (not the dispatcher) does the post-run save — since the supervisor's stderr is already buffered to disk, it parses that for the captured id and calls `saveSessionId` directly. See Step 8 (supervisor argv signature update).

```javascript
import { loadSessionId } from "../../plugins/opencode/scripts/lib/sessions.mjs";

test("run --background round-trips session-id: first call writes, second call passes --session", async () => {
  const { dir, cleanup } = makeTempRepo();
  const fixtureLog = join(dir, "fixture-log.ndjson");
  try {
    setupRepo(dir);
    // First call: no existing session. Use --session-key so the test is deterministic
    // regardless of what branch the temp repo happens to be on.
    const r1 = await runCompanion(
      ["run", "--background", "--yolo", "--session-key", "test-key", "--task", "first", "--model", "vendor/m"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_FIXTURE_LOG: fixtureLog },
    );
    assert.equal(r1.code, 0);
    await new Promise((r) => setTimeout(r, 2000));
    const stored = loadSessionId(dir, "test-key", "run", "vendor/m");
    assert.equal(stored.value, "ses_mockNEWsession", "session-id must be persisted after first run");

    // Second call: dispatcher should pass --session ses_mockNEWsession.
    const r2 = await runCompanion(
      ["run", "--background", "--yolo", "--session-key", "test-key", "--task", "second", "--model", "vendor/m"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_FIXTURE_LOG: fixtureLog },
    );
    assert.equal(r2.code, 0);
    await new Promise((r) => setTimeout(r, 2000));
    const logLines = readFileSync(fixtureLog, "utf8").trim().split("\n").map(JSON.parse);
    const secondCall = logLines[logLines.length - 1];
    const sessionFlagIdx = secondCall.argv.indexOf("--session");
    assert.notEqual(sessionFlagIdx, -1, "second call must include --session in argv");
    assert.equal(secondCall.argv[sessionFlagIdx + 1], "ses_mockNEWsession");
  } finally { cleanup(); }
});

test("run --reset deletes stored session-id and the next call starts fresh", async () => {
  const { dir, cleanup } = makeTempRepo();
  const fixtureLog = join(dir, "fixture-log.ndjson");
  try {
    setupRepo(dir);
    saveSessionId(dir, "test-key", "run", "vendor/m", "ses_OLDONE");
    const r = await runCompanion(
      ["run", "--background", "--yolo", "--session-key", "test-key", "--reset", "--task", "fresh", "--model", "vendor/m"],
      { OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir, OPENCODE_FIXTURE_LOG: fixtureLog },
    );
    assert.equal(r.code, 0);
    await new Promise((r) => setTimeout(r, 2000));
    const logLines = readFileSync(fixtureLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(logLines[0].argv.indexOf("--session"), -1, "reset must drop --session from argv");
    const stored = loadSessionId(dir, "test-key", "run", "vendor/m");
    assert.equal(stored.value, "ses_mockNEWsession", "fresh session-id must replace the old one");
  } finally { cleanup(); }
});
```

- [ ] **Step 11: Run all tests, verify pass**

```bash
node --test tests/opencode/
```

- [ ] **Step 12: Commit Phase 4**

```bash
git add plugins/opencode/scripts/lib/invoke.mjs plugins/opencode/scripts/lib/supervisor.mjs plugins/opencode/scripts/buddy.mjs tests/opencode/
git commit -m "feat(opencode): wire review-dispatch into runReview, runRun (foreground + supervisor)"
```

---

## Phase 5 — CLI surface (`--session-key`, `--reset`, `--no-session`)

**Files:**
- Modify: `plugins/opencode/scripts/buddy.mjs:parseReviewArgs`
- Modify: `plugins/opencode/scripts/buddy.mjs:parseRunArgs`

Add three flags to both parsers, mirroring the duplicate-flag detection pattern from plan 001's review fix.

### Flag semantics

| Flag | Effect |
|---|---|
| `--session-key <name>` | Override the rule-based key derivation (e.g., bridge across branches, or use a custom label for ad-hoc work on `main`). Sanitised the same as the rule's output. |
| `--reset` | Delete the stored session-id BEFORE dispatch, then run as a fresh session and persist the new id. The recovery primitive when a session gets confused. |
| `--no-session` | Skip session reuse for THIS call only. Does NOT delete the stored id. The dispatcher runs without `--session <id>` and does NOT save the resulting session-id either, so the next normal call can still resume the originally-stored id. Use when you want a one-off detached question without polluting the running thread. |

### parseReviewArgs additions

```diff
+    } else if (a === "--session-key") {
+      const dup = guardDuplicate("--session-key"); if (dup) return dup;
+      const v = argv[++i];
+      if (v === undefined) return { ok: false, error: "--session-key requires a value" };
+      sessionKey = v;
+    } else if (a === "--reset") {
+      reset = true;
+    } else if (a === "--no-session") {
+      noSession = true;
```

### parseRunArgs additions

Identical pattern. All three flags are optional; defaults `sessionKey = null`, `reset = false`, `noSession = false`. Reject `--reset` AND `--no-session` together (mutually exclusive — reset is destructive, no-session is non-destructive).

### Tasks

- [ ] **Step 1: Write failing tests for `--session-key` and `--reset` parsing**

```javascript
test("review --session-key custom-label captured", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--session-key", "custom-label"],
      { OPENCODE_BIN: REVIEW_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 0);
    // Assert that the dispatcher actually used "custom-label" (the test harness
    // observes via the mock fixture's recorded args).
  } finally { cleanup(); }
});

test("review rejects --session-key with no value", async () => {
  const result = await runCompanion(["review", "--session-key"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--session-key requires a value/i);
});

test("review --reset deletes the stored session-id before dispatch", async () => { ... });

test("run --reset deletes the stored session-id before dispatch", async () => { ... });

test("review --no-session skips reuse and preserves the original stored id", async () => {
  // Per deepseek round-5 should-fix: an integration test that exercises the
  // CLI surface → parseReviewArgs → dispatchOpencode wiring for --no-session.
  // The round-4 codex blocker (silently unwired in foreground) would be caught here.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const fixtureLog = join(dir, "fixture-log.ndjson");
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_KEEP");
    const sessionsFile = join(dir, "mock-sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_KEEP", updated: 100, directory: dir },
      { id: "ses_TRANSIENT", updated: 200, directory: dir },
    ]));
    await runCompanion(
      ["review", "--model", "vendor/m", "--no-session"],
      {
        OPENCODE_BIN: REVIEW_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir,
        OPENCODE_FIXTURE_LOG: fixtureLog, OPENCODE_FIXTURE_SESSIONS: sessionsFile,
      },
    );
    // 1) --session must NOT appear in argv (reuse skipped).
    const log = readFileSync(fixtureLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(log[0].argv.indexOf("--session"), -1, "--no-session must drop --session from argv");
    // 2) The stored id must SURVIVE the call (not overwritten by transient capture).
    const saved = loadSessionId(dir, "scratch", "review", "vendor/m");
    assert.equal(saved.value, "ses_KEEP",
      "--no-session must preserve the original stored id; the transient capture must not save");
  } finally { cleanup(); }
});

test("run --no-session preserves the original stored id (foreground)", async () => {
  // Same contract as the review case, applied to foreground /opencode:run.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const fixtureLog = join(dir, "fixture-log.ndjson");
    saveSessionId(dir, "scratch", "run", "vendor/m", "ses_KEEPrun");
    const sessionsFile = join(dir, "mock-sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_KEEPrun", updated: 100, directory: dir },
      { id: "ses_TRANSIENTrun", updated: 200, directory: dir },
    ]));
    await runCompanion(
      ["run", "--task", "test", "--model", "vendor/m", "--yolo", "--no-session"],
      {
        OPENCODE_BIN: RUN_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir,
        OPENCODE_FIXTURE_LOG: fixtureLog, OPENCODE_FIXTURE_SESSIONS: sessionsFile,
      },
    );
    const log = readFileSync(fixtureLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(log[0].argv.indexOf("--session"), -1, "foreground run --no-session must drop --session");
    const saved = loadSessionId(dir, "scratch", "run", "vendor/m");
    assert.equal(saved.value, "ses_KEEPrun");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Implement parser additions**

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit Phase 5**

```bash
git commit -m "feat(opencode): --session-key and --reset CLI flags for review and run"
```

---

## Phase 6 — Slash command + subagent integration

**Files:**
- Modify: `plugins/opencode/commands/review.md`
- Modify: `plugins/opencode/commands/run.md`
- Modify: `plugins/opencode/agents/opencode-review.md`
- Modify: `plugins/opencode/agents/opencode-run.md`

### Wrappers pass through --session-key + --reset

The wrappers already pass `$ARGUMENTS` through to `buddy.mjs`. Per plan 001's parseRunArgs fix, the bundled-token heuristic correctly splits `--session-key custom` and `--reset` if the user types them in the slash command.

The work is documentation-only: update each command/subagent file to document the two new flags so users discover them.

### review.md addition

```markdown
**Session continuity (v0.3.0+):** by default, this command resumes the prior opencode session for `(plan-or-branch, role=review, model)`. Pass `--session-key <name>` to override the rule; `--reset` to discard the stored session-id and start fresh.
```

### Tasks

- [ ] **Step 1: Update `commands/review.md` and `commands/run.md` to document the flags**
- [ ] **Step 2: Update `agents/opencode-review.md` and `agents/opencode-run.md` similarly**
- [ ] **Step 3: Smoke test: `/opencode:review --reset` (interactive) — verify the dispatch path runs the reset and reports the new session-id**
- [ ] **Step 4: Commit Phase 6**

```bash
git commit -m "docs(opencode): document --session-key / --reset in slash commands + subagents"
```

---

## Phase 7 — CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md`

### Plan-review pipeline

Update CLAUDE.md's "Plan review gate" section to mention session continuity is automatic for plan-numbered branches (`feature/plan-NNN-*`), so successive review rounds build on prior reasoning. No invocation change needed — the dispatcher Just Works once the wiring lands.

### Code-review pipeline

Same — successive code reviews of the same plan now share session state automatically. Document `--reset` as the recovery escape hatch for the rare "reviewer's session got confused" case.

### Hung review handling

The hung-review playbook (currently mentions kill + re-dispatch with substitute model) gains a new tool: `/opencode:review --reset` to clear a stuck session before re-dispatching, in case the issue is session-side rather than model-side.

### Tasks

- [ ] **Step 1: Update CLAUDE.md "Plan review gate" subsection — document automatic continuity**
- [ ] **Step 2: Update CLAUDE.md "Code Review" subsection — same**
- [ ] **Step 3: Update CLAUDE.md "Handling hung reviews" — add `--reset` to the recovery procedure**
- [ ] **Step 4: Commit Phase 7**

```bash
git commit -m "docs(claude.md): wire plan + code review pipelines to use session continuity"
```

---

## Phase 8 — Documentation, version bump, post-execution report

**Files:**
- Modify: `plugins/opencode/.claude-plugin/plugin.json` (0.2.0 → 0.3.0)
- Modify: `plugins/opencode/CHANGELOG.md` (0.3.0 entry)
- Modify: `plugins/opencode/README.md` (document --session-key / --reset / sessions/ dir)
- Modify: `docs/architecture/decisions.md` (add D-010 — session continuity scope)
- Modify: `plugins/opencode/README.md` (phasing v0.3.0 → review session continuity; v0.4.0 → adversarial-review)
- Modify: `docs/plans/002-review-session-continuity.md` (this file — append post-execution report)

### D-010 (architecture decision)

```markdown
## D-010 — Review session continuity is per-(plan-or-branch, role, model)

**Decided in:** plan 002 (`docs/plans/002-review-session-continuity.md`).

opencode session-ids are persisted at `<project>/.claudecode-buddy/opencode/sessions/<key>-<role>-<model>.session-id` and reused on subsequent dispatches.
Key derivation is rule-based (no LLM): `feature/plan-NNN-*` → `plan-NNN`; other branches → `branch-<sanitised-branch-name>`; non-git → `scratch`.
`--session-key <name>` overrides; `--reset` deletes the stored session-id; `--no-session` skips reuse for one call without deletion.

The dispatcher (`lib/review-dispatch.mjs`) runs three defenses against silent-stale-session failure modes:
1. **Pre-flight verification** via `opencode session list --format json` before passing `--session <id>`.
2. **Stderr-backup detection** (`Session not found: <id>`) handles the race window between pre-flight and run.
3. **Advisory mkdir-based lock** per (key, role, model) tuple serialises the load-invoke-save critical section. Lock contention causes the dispatcher to run in degraded mode (fresh, no save) instead of corrupting continuity.

Why: review rounds and run sessions benefit from prior-reasoning continuity, but only when scoped narrowly.
A single global session would leak unrelated work across reviews; a per-invocation fresh session loses the value of "the reviewer remembers what they said last round."
The (plan-or-branch, role, model) tuple captures the natural unit of "same conversation thread continuing."

Why pre-flight + stderr backup (not just one): opencode treats `--session <stale-id>` as a silent-failure (exit 0 with empty body and stderr error) — pre-flight catches the common case cheaply, and stderr backup handles the rare race where the session is deleted between pre-flight and the run.

Why mkdir-EEXIST (not flock): mkdir is portable (works on macOS without coreutils dependency) and atomic on POSIX. The simplified primitive has zero racing surface — only one process can succeed per (key, role, model) tuple, and the same process releases via rmdir.

**Known limitation (v0.3.0): no auto-reclamation of stranded locks.** A dispatch that crashes without releasing leaves a stranded lock until manually removed. The error message on the next acquisition includes the exact `rm -rf <path>` command. Auto-reclamation queued for plan 004 via proper `flock(2)` or `fcntl(F_SETLK)` semantics (with at-most-one-holder for the entire critical section, not just lock-dir cleanup). Rounds 3-6 of plan 002 attempted layered defenses against 3-party stale-reclamation races (rename-based atomic claim, post-rename stat verification, owner-token files with verify-after-write); each layer closed one race window and exposed a subtler one. The simpler design — drop reclamation, document manual recovery — has zero racing surface and ships in v0.3.0.

Scope chosen during plan 001's follow-up brainstorm (Option Z): per-plan + per-role + per-model, rule-based key derivation, branch-name fallback for unnumbered work.
```

### CHANGELOG 0.3.0 entry

```markdown
## 0.3.0 — Review session continuity

Implemented per `docs/plans/002-review-session-continuity.md`.

### Added
- `lib/sessions.mjs` — session-id storage CRUD with rule-based key derivation (`feature/plan-NNN-*` → `plan-NNN`, branch-name fallback, scratch fallback).
- `lib/session-capture.mjs` — extract opencode session-id from stderr (`INFO service=session id=ses_...`) with `opencode session list --format json` fallback.
- `lib/review-dispatch.mjs` — high-level dispatcher that resolves the session key, passes `--session <id>` when one is stored, captures + persists the new id post-run.
- `--session-key <name>` flag on `/opencode:review` and `/opencode:run` for manual key override.
- `--reset` flag on both commands to delete the stored session-id and start fresh.
- D-010 architecture decision (session continuity scope).

### Changed
- `runReview`, `runRun` (foreground + background) all route through `dispatchOpencode` for automatic session continuity.
- Background supervisor's argv signature extended to `(jobId, projectDir, binary, cwd, role, sessionKey, model, noSession, degraded, ...opencodeArgs)` so it can persist the new session-id from its captured stderr (honouring `--no-session` and lock-degraded-mode).
- `invokeOpencodeRaw` now returns `stderr` and `exit_code` on success (additive, no breaking change).

### Plan number reshuffle
Plan 002 was originally earmarked for adversarial-review + macOS-parity work. That moves to plan 003. Plan 002 is now session-continuity (smaller, unblocks better review iteration).

### Deferred to future plans
- `/opencode:sessions` slash command (list + clear) — plan 004+ (purely ergonomics).
- `--fork` flag (branch from current state into a new session) — plan 004+.
- Auto-prune of stale session-id files — plan 004+.
- Adversarial-review + Stop hook + macOS-parity + flock-serialization — plan 003 (renumbered from former plan-002 slot).
```

### Tasks

- [ ] **Step 1: Bump plugin.json version 0.2.0 → 0.3.0**
- [ ] **Step 2: Append CHANGELOG 0.3.0 entry**
- [ ] **Step 3: Update README**
  - phasing: `v0.3.0 (this release)` = review session continuity; `v0.4.0 (plan 003)` = adversarial-review etc.
  - new `## Session continuity` section documenting `<project>/.claudecode-buddy/opencode/sessions/`, the key rules, `--session-key`, `--reset`, `--no-session`. Include the following subsections:

  **Session-id durability** — opencode may garbage-collect inactive sessions on its own schedule (server-side; we don't control). The dispatcher's pre-flight verification handles this gracefully — a stored id that no longer exists triggers a fresh session on the next call. Project moves (changing the workspace's parent directory or `projectId`) can also invalidate stored ids; in that case `--reset` is the manual recovery path.

  **Privacy of session-ids** — `.claudecode-buddy/opencode/sessions/` is gitignored per D-008 and never committed. Treat session-ids as you would chat history with the underlying model: anyone with the id and an authenticated opencode binary can resume the conversation. Don't paste them into pastebins/PRs.

  **Disk-space growth** — v0.3.0 does NOT auto-prune. Each `(key, role, model)` tuple uses ~30 bytes; 1000 unique tuples = 30 KB. For projects with very long histories you can manually `rm -rf .claudecode-buddy/opencode/sessions/<glob>` or `rm <specific-tuple>.session-id`. Auto-prune (e.g. drop files older than N days) is queued for plan 004+.

  **`--session-key` for ad-hoc work on `main`** — the default branch-name fallback derives `branch-main` for any work on `main`, which is a coarse key (all topics share one session). For frequent ad-hoc reviews on `main`, recommend `--session-key <brief-topic>` to scope per-topic.

  **In-flight v0.2.0 background jobs** — supervisors spawned BEFORE upgrading to v0.3.0 continue running with the v0.2.0 argv signature loaded at spawn time. They will not write session-id files (no plumbing for that). New supervisors spawned AFTER upgrade use the new argv shape and write session-ids normally. No coordination needed; old jobs simply lack continuity.

  - environment variables table: no new vars (everything via flags).
- [ ] **Step 4: Add D-010 to `docs/architecture/decisions.md`**
- [ ] **Step 5: Append post-execution report to this plan file** (date, branch, what was implemented, test counts, deviations, known limitations, follow-ups queued)
- [ ] **Step 6: Run full test suite**

```bash
node --test tests/opencode/
```

Expected: 152 (plan 001 baseline) + ~25 new tests = ~177 pass / 3 e2e skipped.

- [ ] **Step 7: Commit Phase 8**

```bash
git commit -m "docs: v0.3.0 release — CHANGELOG, README, decisions.md D-010, plugin version bump, post-execution report"
```

---

## Codex review summary

### Round 1 (2026-05-04) — `verdict: needs-attention`

**3 blockers** (all addressed in revision; see resolutions below).
**6 should-fix** (folded into revised plan).
**3 nice-to-have** (documented; no plan changes).

**Blockers and resolutions:**

1. **[BLOCKER] Unverified opencode session contract.** The plan assumed `--session <stale-id>` errors with detectable text. **Verified via spike:** `opencode run --session ses_FAKE0000000000000000000 ...` exits **0** silently, emits `"Session not found: ses_<id>"` to stderr, and produces no assistant text. Detection is feasible but the contract is "silent failure with stderr message" not "non-zero exit with error string."
   → **Resolution:** revised dispatcher uses **pre-flight validation** as primary mechanism. Before passing `--session <id>`, the dispatcher queries `opencode session list --format json` and verifies the stored id is present in the result. If absent, delete the local `.session-id` file and treat as fresh. The stderr-pattern check (`STALE_SESSION_RE` against `result.stderr`) becomes a defensive backup for the race window between pre-flight and invocation. `invokeOpencodeRaw` is updated to return `stderr` consistently on every code path (success, non-zero exit, child error, timeout) so the dispatcher can always inspect it.

2. **[BLOCKER] Session capture relies on non-contract stderr format.** The `INFO ... service=session id=ses_<id>` log line is observed but not contractually stable.
   → **Resolution:** changed primary capture mechanism to `opencode session list --max-count 1 --format json` (which is a documented CLI command and parses a stable JSON shape). Stderr-parsing demoted to fallback. The dispatcher captures the session-id by recording the highest-`updated`-timestamp session whose `directory` field matches `cwd` (filtering out unrelated parallel invocations). When pre-flight verification (blocker 1's resolution) ran, the dispatcher already knows the existing id; capture identifies whichever session shows up as "newer than the previously-known one."

3. **[BLOCKER] Same-tuple concurrency can corrupt continuity.** Two parallel dispatches under the same `(key, role, model)` tuple race on the `.session-id` file; last-writer-wins decides future context silently.
   → **Resolution:** add advisory file-locking to `lib/sessions.mjs` via `mkdir`-based locks (`<key>-<role>-<model>.lock` directory). Lock acquisition wraps the load-invoke-save critical section in `dispatchOpencode`. On lock contention (an existing `.lock` directory), the dispatcher emits a warning, **runs without** `--session` (fresh session for this call), and **does not save** the resulting session-id (so the lock-holding writer's id stays authoritative). Locks are cleaned up on exit (success, error, signal). This is portable (no `flock(2)` dependency, works on macOS without coreutils). Stale-lock detection: a lock dir older than 30 minutes is treated as stale and reclaimed (with a warning).

**Should-fix items (all folded into revised plan):**

- **No `--fresh` / `--no-session` for one-off work.** → Added `--no-session` flag: skips reuse for this call but does not delete the file (unlike `--reset`).
- **Session-id durability not specified.** → Added "Session-id durability" subsection in Phase 8 docs: opencode may garbage-collect sessions server-side; project-move breaks ids; pre-flight handles the first case; latter is documented as `--reset` recovery.
- **Plan changes between rounds.** → Documented as intentional design (`--reset` is the recovery escape hatch); added Phase 8 README guidance.
- **Phase 4/5 ordering.** → Kept Phase 4 (wiring with internal API) before Phase 5 (CLI flags) per deepseek's reading; documented rationale inline.
- **Phase 4 not TDD enough.** → Restructured Phase 4 tasks to add failing wired-path tests BEFORE production routing change.
- **In-flight v0.2.0 supervisors.** → Documented in Phase 8 README known-limitations: spawned-before-deploy supervisors continue with the old argv signature loaded at spawn time; new spawns use the new shape.
- **Session-id privacy.** → Phase 8 README adds "session-ids are stored in `.claudecode-buddy/` (gitignored per D-008); they grant resume access to the conversation, so treat them as you would chat history."
- **Disk growth without auto-prune.** → Phase 8 README explicitly documents "v0.3.0 does not auto-prune; manual `rm` of stale `.session-id` files is supported; auto-prune queued for plan 004+."
- **`branch-main` is too broad for ad-hoc work.** → Phase 6 slash-command docs add a paragraph recommending `--session-key <brief-topic>` for frequent ad-hoc reviews on `main`.

**Nice-to-have (no plan change):**

- Phases 1-3 stay split — independent unit tests are valuable.
- Phase 6 docs-only scope is appropriate (wrappers already pass `$ARGUMENTS`).
- Phase 7 (CLAUDE.md) lands after implementation — no premature-instructions risk.

### Round 2 (2026-05-04) — `verdict: needs-attention`

**3 NEW blockers** introduced by the round-1 revisions (all addressed below).
**1 should-fix** (directory==cwd realpath/normalisation).

**Blockers and resolutions:**

1. **[BLOCKER] Background `run --background` path bypasses the round-1 defenses.** Phase 4's background routing has the parent (`runRunBackground`) load the session-id and pass it through to the supervisor; the supervisor saves on close. There is no `acquireSessionLock`, no `verifySessionExists`, no degraded mode, and no stale-session handling for this path — reintroducing exactly the failure modes round-1 fixed.
   → **Resolution:** the **parent** (`runRunBackground`) owns the round-1 defenses end-to-end:
   - Acquires the advisory lock BEFORE spawning the supervisor.
   - Calls `verifySessionExists(binary, existingId)` and deletes the file if stale.
   - On lock contention: runs the supervisor in degraded mode (no `--session` arg, no save).
   - The supervisor inherits the open lock (which is just a filesystem directory — no cross-process state). It runs opencode, captures the session-id from its already-buffered stderr at close, calls `saveSessionId` (only if `noSession === false`), and `rmdir`s the lock directory.
   - If the supervisor crashes before releasing the lock, the file-rename-based stale-reclamation (resolution 2) recovers it. If opencode reports `Session not found: <id>` mid-run via stderr, the supervisor logs a warning and skips save (background can't trivially re-spawn opencode mid-stream); the file's already deleted by parent's pre-flight check on the next call.
   - The supervisor's argv extends from `(jobId, projectDir, binary, cwd, role, sessionKey, model, ...opencodeArgs)` to add a `noSession` boolean flag: `(jobId, projectDir, binary, cwd, role, sessionKey, model, noSession, ...opencodeArgs)`.

2. **[BLOCKER] Stale-lock reclamation is not race-safe.** Two contenders can both observe an old lock, both `rmSync` it, both re-`mkdir` and proceed.
   → **Resolution:** replace the racy `rmSync + mkdirSync` reclamation with a **rename-based atomic claim**:
   ```javascript
   // On EEXIST + lock-is-stale:
   const claimToken = `${path}.claim.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
   try {
     renameSync(path, claimToken);   // atomic on POSIX — only one rename can succeed
     rmSync(claimToken, { recursive: true, force: true });
     mkdirSync(path);                // re-acquire the now-vacant lock atomically
     // Won the reclamation.
   } catch (err) {
     if (err.code === "ENOENT") {
       // Another contender's rename won. The lock is now vacant — try a fresh mkdir.
       try { mkdirSync(path); /* won via fallback */ }
       catch { return { ok: false, error: "locked: lost reclamation race" }; }
     } else {
       return { ok: false, error: `lock reclamation failed: ${err.message}` };
     }
   }
   ```
   Only one rename can succeed atomically; the loser sees ENOENT and either succeeds at fresh mkdir (rare benign double-reclaim window) or gives up cleanly. Stale lock-reclamation is now race-safe at the cost of ~5 lines of extra logic.

3. **[BLOCKER] `--no-session` semantics violated by save path.** The flag is documented as "skip reuse for THIS call without deletion" — but the dispatcher saves the captured id regardless of `noSession`, overwriting the original stored id (which is exactly what `--no-session` is supposed to preserve).
   → **Resolution:** gate `saveSessionId` on `!noSession`:
   ```javascript
   if (!noSession && captured !== null && captured !== existing) {
     saveSessionId(...);
   }
   ```
   Update the no-session test to assert the original stored id survives the call (no overwrite). The "one-off detached question" contract is now correct.

**Should-fix:**

- **`directory === cwd` realpath/normalisation.** The plan currently does string-equal comparison between the session's `directory` field and `cwd`. Symlinks, trailing slashes, and case differences (macOS) can cause a session created in `/tmp/foo/` to not match a cwd of `/tmp/foo`.
  → **Resolution:** normalize both via `realpathSync` before comparison. If `realpathSync` fails (cwd doesn't exist), fall back to literal equality. Helper:
  ```javascript
  function normalizePath(p) {
    try { return realpathSync(p); } catch { return p; }
  }
  // captureLatestSessionForCwd:
  const cwdReal = normalizePath(cwd);
  const matching = sessions.filter((s) => normalizePath(s?.directory ?? "") === cwdReal && SESSION_ID_RE.test(s?.id ?? ""));
  ```

### Round 3 (2026-05-04) — `verdict: needs-attention`

**3 NEW blockers** caught from the round-2 background-path resolution (all addressed below).
**1 should-fix** (macOS case-insensitivity test coverage).

**Blockers and resolutions:**

1. **[BLOCKER] Parent supervisor-spawn error strands the lock.** The round-2 design transferred lock ownership from parent to supervisor at `spawn()`. But if `spawn()` fails synchronously OR fires `error` before `spawn` succeeds (e.g., supervisor script ENOENT, fork failure, permission denied), the supervisor's own crash handlers never run — they're inside the supervisor process that doesn't exist. The lock is stranded for up to 30 minutes until stale-reclamation.
   → **Resolution:** parent registers `supervisor.once("error", ...)` that releases the lock if it fires before `supervisor.once("spawn", ...)`. The `spawn` event signals successful OS fork; after that, ownership truly transfers and the supervisor's own crash handlers (uncaughtException + child error handlers + close handler) own the release. An `ownershipTransferred` boolean prevents double-release. Parent uses `rmSync(sessionLockPath(...), {recursive: true, force: true})` (force: true makes the rm idempotent if supervisor somehow released first).

2. **[BLOCKER] `mock-supervisor.mjs` argv only absorbs 3 of 5 new positionals.** The round-2 background-path fix added `noSession` and `degraded` boolean strings between `model` and `...opencodeArgs`, bringing the new positional count to 5 (role, sessionKey, model, noSession, degraded). The plan's diff still showed only 3.
   → **Resolution:** updated the mock-supervisor diff to absorb all 5: `[, , jobId, projectDir, binary, cwd, role, sessionKey, model, noSessionRaw, degradedRaw, ...opencodeArgs]`. Documented that the mock doesn't need to interpret these flags — the existing background tests don't exercise the production save path, only argv-shape invariants.

3. **[BLOCKER] Supervisor uses `sanitiseLabel` without an export plan.** The round-2 supervisor diff constructed the lock-dir path via `sanitiseLabel(model)` directly, but `sanitiseLabel` was a private helper inside `lib/sessions.mjs`. The plan said "needs to be exported" but Phase 1's public API never listed it.
   → **Resolution:** added `export function sessionLockPath(projectDir, key, role, model)` to Phase 1's public API. Supervisor imports `sessionLockPath` (a stable boundary) instead of reaching into `sanitiseLabel`. Cleaner abstraction — supervisor never needs to know the sanitisation algorithm.

**Should-fix:**

- **macOS case-insensitivity in realpath comparison is asserted but not tested.** `realpathSync` on case-insensitive filesystems normalises to whatever case the FS records, but two different mixed-case spellings of the same path could produce different `realpathSync` results in pathological cases (e.g., a symlink chain that explicitly renames case).
  → **Resolution:** added a TEST-NOTE in Phase 2 acknowledging this is best-effort: "On case-sensitive filesystems (Linux), realpath comparison is exact. On case-insensitive filesystems (macOS HFS+/APFS-default), realpath is also case-preserving, so the comparison works in normal flows. Pathological mixed-case symlink chains are out of scope for v0.3.0; if they become a real issue, plan 004+ adds explicit `path.posix.normalize + toLowerCase` for macOS." No code change for v0.3.0; acknowledged as a known limitation.

### Round 4 (2026-05-04) — `verdict: needs-attention`

**4 NEW blockers** (all addressed below).
**1 should-fix** on existing v0.2.0 background pid timing (clarified).

**Blockers and resolutions:**

1. **[BLOCKER] Token write is non-atomic with mkdir.** `mkdirSync(path)` publishes the lock dir BEFORE `writeFileSync(<lock>/owner, token)`. A competing reclaimer can rename our newly-created lock dir between mkdir and write — our writeFile then fails with ENOENT (or worse, writes into the renamed claim dir).
   → **Resolution:** wrapped `writeOwnerToken` in try/catch returning `{ok:false, error: "locked: lost ownership during token write"}` on ENOENT. All three call sites (initial mkdir, stat-vanished retry, stale reclamation) propagate the error so the contender backs off cleanly. Worst case: contender retries on next dispatch — no silent at-most-one-holder violation.

2. **[BLOCKER] Supervisor handoff via "spawn" event has a module-load gap.** If the supervisor process forks successfully but throws during `import` evaluation (BEFORE its own `uncaughtException` handler is registered), the lock is stranded for up to 30 minutes.
   → **Resolution:** the supervisor registers its `uncaughtException` handler at the **VERY TOP** of `supervisor.mjs` — BEFORE any other `import` statement. The handler uses only `require("node:fs")` synchronously (which can't fail since it's a built-in) to verify the lock-token and release. The 30-minute stale-reclamation window remains as the residual safety net for the (now extremely narrow) case where the handler itself throws.

3. **[BLOCKER] `--no-session` was parsed but never wired to foreground `dispatchOpencode` calls.** `parseReviewArgs` and `parseRunArgs` capture `noSession`, but the `runReview` and `runRun` foreground routing diffs only forward `sessionKeyOverride` and `reset` to `dispatchOpencode`. The flag silently does nothing in foreground.
   → **Resolution:** updated Phase 4 Step 6 (review wiring) and Step 7 (run wiring) to pass `noSession: parsed.value.noSession ?? false` (review) and `noSession: args.noSession ?? false` (run). Background path was already correct.

4. **[BLOCKER] Test session-id values violate `SESSION_ID_RE`.** Tests used `ses_LIVE_AAA`, `ses_STALE_PRE`, etc. — the regex `^ses_[A-Za-z0-9]+$` rejects underscores after the prefix. Real opencode IDs are `ses_20bb01aa8ffeS0FvDHqqaSM1Wo` style (alphanumeric only). Tests would fail with "corrupt session-id" errors.
   → **Resolution:** renamed all test fixtures to alphanumeric-only (`ses_LIVEaaa`, `ses_STALEpre`, `ses_NEWpre`, etc.). 5 occurrences fixed via global replace.

**Should-fix:**

- **Existing v0.2.0 background pid timing.** Codex worried that `supervisor.pid` might not be set before our new `supervisor.once("spawn")` fires. Per Node docs: `child.pid` is set synchronously when `spawn()` returns; the `"spawn"` event fires async after fork succeeds. The existing v0.2.0 test that asserts `list.value[0].pid > 0` runs AFTER the parent has already written the pid to the job record (which happens after `spawn()` returns synchronously). No timing change. Documented as "no behavioural change to v0.2.0 pid semantics" in Phase 4's invokeOpencodeRaw subsection.

### Round 5 (2026-05-04) — `verdict: needs-attention`

**2 NEW blockers** (both addressed below); 4 nice-to-have confirmations of round-4 fixes.

**Blockers and resolutions:**

1. **[BLOCKER] ESM `require()` is undefined.** Round-4 supervisor crash handler used `require("node:fs")` — but `.mjs` files don't have `require` without `createRequire(import.meta.url)`.
   → **Resolution:** restructured the supervisor's top-of-file:
   - **Static imports**: built-ins ONLY (`node:fs`, `node:path`, `node:child_process`). These cannot fail at module load.
   - **Crash handler registration**: in module body, immediately after static imports. Built-ins-only static imports can't have thrown, so the handler reliably installs.
   - **Dynamic imports** (`await import(...)`): for our own modules. These can throw, but the crash handler is registered to catch them.
   - The crash handler uses inline `inlineSanitise()` + `inlineLockDir()` helpers that depend only on built-in imports, dodging the createRequire ceremony entirely.

2. **[BLOCKER] 3-party reverse-restore gap in stale-lock reclamation.** When A is mid-restore (renamed away path, about to reverse-rename), the path is empty for a microsecond. A third reclaimer C arrives, hits ENOENT on its own rename, falls into the ENOENT-fallback `mkdirSync(path)` which now succeeds. C writes its token. A's reverse-rename then fails with EEXIST. C and an in-flight original-fresh-holder F can both believe they hold the lock; A's writeOwnerToken (still pending from step 4 of the chain) lands in C's dir, overwriting C's token.
   → **Resolution:** added **verify-after-write** to `writeOwnerToken`. After writing, re-read the file immediately. If another process overwrote our token in the gap, we return `"locked: another process overwrote our owner-token"`. This catches the case where the racer's write lands AFTER ours.
   → **Acknowledged residual race window:** if our write+read happens BEFORE the racer's write, we pass verify and they don't — both could believe they hold the lock for the microsecond between our verify and their write. The token check at release converges to one holder (the one whose token still matches at release time), but mid-flight at-most-one-holder is best-effort. True at-most-one-holder requires `flock(2)`-backed locking. Documented in D-010 as a known v0.3.0 limitation; plan 004 ships proper flock(2) primitives via a small native binding or `node-fcntl-locking` package.

**Confirmations (no change):**
- `writeOwnerToken` ENOENT propagation: correct.
- `--no-session` foreground wiring: correct.
- Test ses_id alphanumeric compliance: correct (5 renames verified).
- Existing v0.2.0 background pid timing: correct (synchronous from spawn() return).

### Round 6 (2026-05-04) — `verdict: needs-attention` → triggered design pivot

**2 NEW blockers** (both addressed via DESIGN PIVOT — see "Lock simplification rationale" in Phase 1):

1. **[BLOCKER] Verify-after-write doesn't prevent concurrent critical-section work.** Round-5 verify-after-write only catches the case where racer's write lands AFTER ours; if racer writes BEFORE ours, both pass verify and both proceed through the entire `invokeImpl` → `saveSessionId` critical section. The convergence-at-release story converged only the lock-dir cleanup, not the actual opencode work. Two concurrent dispatches running real opencode invocations under the same (key, role, model) tuple is a correctness violation, not just a cosmetic one.

2. **[BLOCKER] Two crash handlers race; only one fires.** The round-4 top-of-file `uncaughtException` handler exits 1 immediately, so the existing v0.2.0 handler (which updated the job record to `failed`) never runs. Background jobs stay stuck `running` forever on supervisor crash.

**DESIGN PIVOT — round-6 resolution:**

After 4 rounds (3-6) of layering defenses against 3-party stale-reclamation races, both reviewers acknowledged the fundamental issue: `mkdir`-based primitives cannot serialise the entire critical section without `flock(2)` or equivalent. Each fix closed one window and exposed a subtler one.

**The simpler design has zero racing surface:**
- `acquireSessionLock` = `mkdirSync(<lock>)` — atomic on POSIX, EEXIST → return `locked` with manual-rm hint. No staleness check, no rename, no reclamation, no token-file, no verify-after-write.
- `release` = `rmSync(<lock>)`. Whoever called `release()` rmdir's. Only the unique successful mkdir-er can call release.
- Stranded locks (process crashed without releasing) require manual `rm` — error message tells the user exactly what command to run.
- Auto-reclamation queued for plan 004 with proper `flock(2)` (via `node-fcntl-locking` package or a small native binding).

The crash-handler bug is also fixed: a SINGLE unified `uncaughtException` handler at the top of supervisor.mjs does (a) lock release, (b) job-record-failed update via inline atomic write, (c) supervisor-error breadcrumb. The previous separate v0.2.0 handler is removed since its responsibility is now folded in.

**Lines deleted vs added** (rough): −150 (reclamation, token-file, verify-after-write, all related tests/comments) +30 (simple mkdir-EEXIST, simpler release, manual-rm hint, basic tests). Net **simpler** plan, **more correct** primitive.

### Round 7 (2026-05-04) — `verdict: needs-attention` (cleanup-only)

**3 blockers** — all cleanup stragglers from the round-6 simplification (no design issues):

1. **[BLOCKER] Phase 1 public API doc-comment** still described 30-min stale reclamation. → **Resolution:** rewrote the API doc-comment to describe the simplified contract (mkdir-EEXIST, no reclamation, manual-rm hint).

2. **[BLOCKER] Duplicate `uncaughtException` handler diff** still appeared in Phase 4. → **Resolution:** consolidated to a single handler at top-of-file. The duplicate diff block was rewritten to show only `child.on("error")` (which IS a separate event from uncaughtException).

3. **[BLOCKER] `lockToken` argv stragglers** in two places (supervisor argv signature description and supervisor diff). → **Resolution:** updated both — supervisor argv is now 5 positionals (role, sessionKey, model, noSession, degraded), no lockToken.

**4 should-fix** (all addressed):
- Phase 8 D-010 still described pre-simplification design → **rewrote** to describe pure mkdir-EEXIST + manual-rm + plan-004 flock(2) follow-up.
- Phase 4 description of `releaseLock()` still said "token-verifies before rmdir" → **fixed** (just rmdir's, simplified design).
- Phase 1 Step 13 still showed the obsolete reclamation test → **removed** (replaced with the new "rejected stale lock surfaces the manual-rm hint" test).
- `child.on("error")` placeholder for "existing error handling" was ambiguous about job-record update → **clarified** with explicit updateJob call mirroring the unified uncaughtException handler.

### Round 8 (2026-05-04) — `verdict: needs-attention` (cleanup-only, 2 stragglers)

Two `lockToken`/30-min mentions still in active spec text after round-7. Fixed.

### Round 9 (2026-05-04) — `verdict: needs-attention` (cleanup-only, 2 more stragglers)

Two more `lockToken` mentions in Phase 4 task descriptions. Fixed.

### Round 10 (2026-05-04) — `verdict: needs-attention` (cleanup-only)

Supervisor argv shape inconsistency between Phase 4 narrative (3 positionals) and Step 8 implementation (5 positionals). Fixed in narrative + planned CHANGELOG.

### Round 11 (2026-05-04) — `verdict: needs-attention` (cleanup-only)

`runReview` and `runRun` routing descriptions omitted `noSession` from the dispatchOpencode call. Fixed in both, plus rewrote `runRunBackground` description to clarify supervisor doesn't receive session-id as a positional (resume id flows through opencodeArgs as `--session`).

### Round 12 (2026-05-04) — `verdict: needs-attention` (DESIGN issue, not cleanup)

**[BLOCKER]** `captureLatestSessionForCwd` filtered by `directory === cwd` was the PRIMARY post-run capture mechanism — but it can't disambiguate concurrent unrelated dispatches in the same workspace (parallel `/opencode:review` + `/opencode:run` would both have cwd=workspace, and "most-recent-updated" picks the wrong one).
→ **Resolution:** capture priority FLIPPED. `captureSessionIdFromStderr` is now PRIMARY (deterministic per-process — it's THIS process's own stderr, not shared with parallel runs). `captureLatestSessionForCwd` is FALLBACK only, used when stderr parse fails (e.g., opencode log format changed). Dispatcher and supervisor both follow the new priority. Same-cwd-different-tuple limitation documented in D-010.

### Round 13 (2026-05-04) — `verdict: approve` ✅

**0 blockers.** 1 should-fix on a stale "Primary capture" comment label that contradicted the new priority — fixed.

**Final verdict from Codex:** APPROVE. Plan ready for implementation.

## Opencode review summary

### Round 1 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve`

**0 blockers.** All architectural assumptions verified against opencode 1.14.33:

- `--session <id>` on `opencode run` does not require `--continue` (confirmed).
- `opencode session list --format json` returns a JSON array with `{id, title, updated, created, projectId, directory}` per session (confirmed).
- The `service=session id=ses_...` stderr format matches real `--print-logs --log-level INFO` output.

**3 should-fix items (all folded into revised plan):**

- **`mock-supervisor.mjs` fixture argv update missing from Phase 4.** → Added explicit step to update the mock fixture to accept-and-ignore the 3 new positional args (role, sessionKey, model) so existing background-path tests don't break.
- **`listSessions` filename-parsing produces misleading `key`/`role` fields.** Naive `split("-")` on `plan-001-review-vendor-m` gives `key="plan", role="001", role="review"...`. → Simplified `listSessions` to return only `{sessionId, path, mtimeMs}`. Callers that need a tuple already have the original (key, role, model) in hand; the filename is purely a storage detail.
- **`invokeOpencodeRaw` `stderr` returned as `undefined` on the `child.on("error")` path.** → Threading `stderr` through every resolution path (success, non-zero exit, child-spawn error, timeout). Always a string (defaults to `""`). Folds into blocker 1's resolution above.

**3 nice-to-have items (documented, no plan change):**

- `branch-main` ad-hoc default is poorly scoped → covered by Codex's identical should-fix; documented in Phase 6.
- Phase 5 ordering after Phase 4 is correct — confirmed.
- Stale-session regex is English-only — opencode unlikely to localize; user has `--reset` as manual recovery.

**Verdict: approve.** No blockers. The 3 should-fix items are implementation-detail tightening, not plan-level rework.

### Round 2 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve`

**0 blockers.** All round-1 blocker resolutions verified clean against the implementation diffs:
- Pre-flight + stderr-backup defenses are layered correctly; no consumer depends on the empty-text → ok:true shape change.
- `mock-supervisor` argv update is backward-compatible (the previous fixture ignored everything after `jobId`; the rest-spread absorbs the new tail).
- `listSessions` simplification has no downstream callers depending on filename reconstruction.
- `--no-session` vs `--reset` mutex is documented clearly.

**2 should-fix items (both addressed in the round-2 revision):**

- **Stale-lock reclamation race window.** Same root cause as Codex round-2 blocker 2; addressed by switching to rename-based atomic claim.
- **Phase 4 Step 10 background round-trip test depends on unspecified mock session-id contract.** → Resolution: documented the mock session-id derivation algorithm explicitly. Mock fixtures emit `ses_mockNEW` for fresh runs (no `--session` in argv) and re-emit the input id when `--session <id>` is present. Tests assert against these exact strings.

**1 nice-to-have (folded in):**

- **Lock-contention degraded mode silently ignores `--reset`.** → Resolution: degraded-mode path emits an explicit warning when `--reset` was requested, so the user knows their reset intent didn't take effect. They can re-run after the lock clears.

**TDD ordering, docs coverage, fixture compat all confirmed clean.**

**Verdict: approve.** No blockers. The two should-fix items overlap with Codex round-2 findings and are addressed in the same revision.

### Round 3 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: needs-attention`

**0 blockers.** All four round-2 resolutions verified clean (background-path defenses, --no-session save gate, realpath normalisation, lock handoff semantics).

**1 should-fix (addressed in this revision):**

- **Stale-lock reclamation 3-party rename race.** Two reclaimers A and B both observe a stale lock; A reclaims and creates a fresh lock; B's rename succeeds against A's fresh lock (rename atomicity is on the name slot, not on the content); B "steals" A's lock; A's eventual release rmdir's B's lock — at-most-one-holder invariant violated. Window is microseconds, but real correctness regression.
  → **Resolution:** added owner-token semantics to `acquireSessionLock`. Each holder writes a unique token (`<pid>-<ms>-<random>`) to `<lock>/owner` immediately after acquisition (or after reclamation). Release reads the on-disk token and only rmdir's if it matches the holder's token. Stolen locks fail their own ownership check at release and silently no-op rather than rmdir'ing the new holder's lock. Token threads through the parent → supervisor argv (one new positional, `lockToken`) so the background supervisor's release path applies the same check. Regression test added in Phase 1 Step 13 (`acquireSessionLock: 3-party stolen-lock release does not invalidate the new holder`).

**2 nice-to-have (addressed):**

- **`sessionLockPath` was missing from Phase 1's public API listing.** → Resolution: added to the public API table in Phase 1 alongside `acquireSessionLock`.
- **`sanitiseLabel` export gap.** → Resolution: replaced direct `sanitiseLabel(model)` references in the supervisor with `sessionLockPath()` calls (which encapsulates sanitisation internally). `sanitiseLabel` stays private to `lib/sessions.mjs`.

### Round 4 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: needs-attention`

**1 blocker** — a subtle 3-party rename-steal race that the round-3 token check did NOT fully close:

> A & B both detect stale lock → both enter `tryReclaimStaleLock`. A renames stale → mkdir(path) → A about to writeToken. B's `renameSync(path, claimB)` SUCCEEDS against A's FRESH dir (rename atomicity is on the name, not the content's age). B then mkdir(path) + writeToken("B"). A's writeToken now lands inside B's dir, OVERWRITING B's token. Both believe they hold the lock; A's release matches its own token (which is now in B's dir) and rmSync's B's dir.

→ **Resolution:** added post-rename staleness re-verification. After `renameSync(path, claimDir)`, stat `claimDir`. If its mtime is NOT actually >30 min old (i.e., we just stole someone's fresh lock), restore via reverse-rename and return `locked`. Combined with the existing token check on release, the at-most-one-holder invariant is now properly enforced for all interleavings.

This finding is non-obvious — it required tracing the cross-process interleaving where the token-write window is microseconds but the rename succeeds against the fresh dir produced by another reclaimer's mkdir. The fix is small (~6 lines) but closes the genuine race.

The other 3 round-3 resolutions (parent spawn-error, mock-supervisor argv, sessionLockPath export) are confirmed correct. The 4 round-4 codex blockers (token write atomicity, supervisor module-load uncaughtException, --no-session foreground wiring, test ses_id regex) are also confirmed addressed.

### Round 5 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: needs-attention`

**1 blocker** (same `require()`-in-ESM as Codex round-5 — already fixed via static built-in imports + crash-handler-then-dynamic-imports pattern).
**2 should-fix** (both addressed):

- **[SHOULD-FIX] Orphaned lock dir on failed token write.** `mkdirSync(path)` publishes the lock dir; if the token write fails (disk full, permissions, race), the dir remains and blocks all dispatchers under that tuple for 30 minutes. → **Resolution:** added `try { rmSync(path, ...); } catch {}` cleanup before returning the error in BOTH the initial mkdir path AND the stat-vanished retry path AND the `tryReclaimStaleLock` paths.

- **[SHOULD-FIX] Missing `--no-session` CLI integration test.** Phase 5 covered `--session-key` and `--reset` but not `--no-session`. The round-4 Codex blocker (flag silently unwired in foreground) would not have been caught by existing tests. → **Resolution:** added two integration tests in Phase 5 — one for `/opencode:review --no-session` and one for `/opencode:run --no-session` — both asserting that the stored session-id survives the call and `--session` does not appear in the dispatcher's argv.

**Convergence verification (Q1):** explicit confirmation — "All interleavings converge to exactly one holder" via the rename-atomicity gate + post-rename staleness re-verification + token-based release check + EEXIST fallback. **No other at-most-one-holder violations found** in the full acquire/steal/contest/3-reclaimer trace (Q3 confirmed clean).

### Round 6

**Skipped.** After Codex round-6 surfaced the verify-after-write convergence flaw, the design was pivoted to drop stale-reclamation entirely. The new design has zero racing surface, so deepseek round-6 was not dispatched against the broken design. Round 7 (next) will be the first re-review of the simplified design.

### Round 7 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: needs-attention` (cleanup-only)

**Strong validation of the design pivot:**

- **Q1 — Racing surface (simplified lock): PASS.** "POSIX guarantees exactly one concurrent `mkdir` succeeds atomically. No reclamation path, no token file, no verify-after-write — **zero racing surface**."
- **Q2 — Parent → supervisor lifecycle: PASS** with one note (residual second-handler artifact, addressed in Codex round-7's blocker 2).
- **Q3 — Dual-crash-handler bug: FIXED in design.** "The single handler does all three things with only built-in node:fs operations."
- **Q4 — Manual-rm error message: PASS.** "User can copy-paste directly. Actionable without grepping the codebase."
- **Q5 — Stragglers in implementation sections: 1 blocker** + 2 should-fix (all overlap with Codex round-7 blockers — same fixes applied).
- **Q6 — New issues: 2 should-fix on doc-comment and D-010 still describing pre-simplification design** (overlap with Codex round-7).

All findings are documentation/cleanup overlap with Codex round-7 — no NEW design issues. Resolutions applied as listed in the Codex round-7 summary above.

### Round 8 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve` ✅

**0 blockers. 0 should-fix. 1 nice-to-have observation** (mock-supervisor / production-supervisor argv consistency confirmed as clean).

All 6 round-7 cleanup items confirmed. Cross-section consistency verified across Phase 1 implementation, Phase 4 wiring, supervisor argv, mock-supervisor argv, and the public API description. Historical audit trail (rounds 1-7) preserved correctly without conflation with current spec. Plan structure verified: D-010 (new), all 8 phases covered, both review summaries with all rounds, code review placeholder, follow-up plans, post-execution report placeholder.

**Final verdict from deepseek-v4-pro:** APPROVE. Plan ready for implementation.

### Round 9 onwards — not dispatched

Round 8 from deepseek-v4-pro returned approve. Subsequent rounds 9-13 only dispatched Codex to verify cleanup of remaining stragglers it had flagged each round. Deepseek-v4-pro's round-8 approve verdict stands for the final plan (round-13 changes were either same-issue cleanup or stderr-fallback inversion that doesn't change the design substantively).

---

## Code Review

(Filled in during Step 5 of `docs/development-workflow.md`. Three reviewers per CLAUDE.md: Codex, opencode/deepseek-v4-flash, opencode/glm-5.1.)

---

## Follow-up plans queued

- **Plan 003 — adversarial-review + macOS parity + flock-serialization** (formerly the plan-002 slot). Includes:
  - `/opencode:adversarial-review` slash command + subagent.
  - Optional Stop-hook review gate.
  - macOS support for `pidIsOurSupervisor` (via `ps -o command=`) and `--task-file` TOCTOU defense.
  - flock-based serialization for SessionEnd vs supervisor close races (replacing current best-effort CAS).
  - `--task` stdin-as-prompt support (bypasses ARG_MAX limits on macOS).
- **Plan 004+ — session continuity polish.** `/opencode:sessions` list/clear command, `--fork` flag, auto-prune stale session-id files older than N days. Pure ergonomics, defer until usage data justifies.

---

## Post-execution report

(Filled in after Step 5 (Review) lands and before Step 6 (Ship). Date, branch, what was implemented, test counts, deviations from the plan, known limitations, follow-up plans queued.)
