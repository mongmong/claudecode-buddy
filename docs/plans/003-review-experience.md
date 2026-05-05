# Plan 003 — Review experience (adversarial-review style + Stop-hook gate)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship two review-experience features in v0.4.0:
(1) `--style adversarial` flag on `/opencode:review` for hostile-perspective critique without a separate slash command;
(2) opt-in Stop-hook review gate that auto-triggers a review of Claude's just-completed turn (mirroring codex's `stop-review-gate-hook.mjs` design) — with smart-skip for non-actionable turns and fail-open recovery.

**Architecture:** the `--style` flag is a thin shim — new prompt template + role-suffix in the session-continuity tuple, no other infrastructure changes. The Stop-hook gate matches codex's implementation pattern: workspace-level opt-in config flag, hook script invoked by Claude Code on every `Stop` event, hook reads the config + last assistant message + diff, runs review via `dispatchOpencode`, emits `{decision: "block", reason: ...}` on needs-attention or fails open on errors. Two new architectural decisions: D-011 (Stop-hook gate semantics) and a workspace-config convention for plugin runtime settings (`<project>/.claudecode-buddy/<plugin>/config.json`).

**Tech stack:** Node ≥ 18.18 built-ins, `node:test`, opencode CLI ≥ 1.14, Claude Code Stop/SessionStart hook contract.

**Plan number:** 003 (next sequential after plan 002 v0.3.0).
**Target plugin version:** opencode v0.4.0.

---

## Phases

| # | Component | Files |
|---|---|---|
| 1 | `lib/config.mjs` — workspace plugin config CRUD | `plugins/opencode/scripts/lib/config.mjs` (new), `tests/opencode/config.test.mjs` (new) |
| 2 | `--style adversarial` flag + prompt template | `plugins/opencode/prompts/adversarial-review.md` (new), `plugins/opencode/scripts/buddy.mjs:parseReviewArgs`, `plugins/opencode/scripts/buddy.mjs:buildReviewPrompt`, `plugins/opencode/scripts/buddy.mjs:runReview`, `tests/opencode/review-cmd.test.mjs` |
| 3 | `/opencode:gate` slash command | `plugins/opencode/commands/gate.md` (new), `plugins/opencode/scripts/buddy.mjs:runGate` (new dispatch), `tests/opencode/gate-cmd.test.mjs` (new) |
| 4 | `stop-review-gate-hook.mjs` (smart-skip + fail-open + opt-in check) | `plugins/opencode/scripts/stop-review-gate-hook.mjs` (new), `tests/opencode/stop-gate.test.mjs` (new) |
| 5 | Hooks.json registration + prompt template | `plugins/opencode/hooks/hooks.json`, `plugins/opencode/prompts/stop-review-gate.md` (new) |
| 6 | Slash command + subagent + CLAUDE.md updates | `plugins/opencode/commands/review.md`, `plugins/opencode/agents/opencode-review.md`, `CLAUDE.md` |
| 7 | Documentation + D-011 + version bump | `plugins/opencode/CHANGELOG.md`, `plugins/opencode/README.md`, `plugins/opencode/.claude-plugin/plugin.json`, `docs/architecture/decisions.md` (D-011), `docs/plans/003-review-experience.md` post-execution report |

---

## Phase 1 — `lib/config.mjs` (TDD)

**Files:**
- Create: `plugins/opencode/scripts/lib/config.mjs`
- Create: `tests/opencode/config.test.mjs`

The Stop-hook gate needs a workspace config flag. Other features in plans 004+ may add more flags. Establish the convention now: one JSON file per plugin at `<project>/.claudecode-buddy/<plugin-name>/config.json`, with atomic CRUD.

### Public API

```javascript
// Default config (returned when file is absent or unreadable).
export const DEFAULT_CONFIG: { stopReviewGate: false }

// Path: <projectDir>/.claudecode-buddy/opencode/config.json
export function configPath(projectDir): string

// Load and parse the config. Returns DEFAULT_CONFIG when the file doesn't
// exist or contains invalid JSON (non-fatal; logs warning to stderr).
// Returns { ok, value: <merged config> } or { ok: false, error } only on
// truly catastrophic errors (e.g., I/O permission failure).
export function loadConfig(projectDir): { ok, value, error? }

// Atomically write a partial patch on top of the current config. Same
// .tmp+rename pattern as lib/jobs.mjs / lib/sessions.mjs.
export function updateConfig(projectDir, patch): { ok, value, error? }
```

### Implementation

```javascript
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  stopReviewGate: false,
});

export function configPath(projectDir) {
  return join(projectDir, ".claudecode-buddy", "opencode", "config.json");
}

export function loadConfig(projectDir) {
  const path = configPath(projectDir);
  if (!existsSync(path)) return { ok: true, value: { ...DEFAULT_CONFIG } };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `failed to read ${path}: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`warn: ${path} is not valid JSON (${err.message}); using defaults\n`);
    return { ok: true, value: { ...DEFAULT_CONFIG } };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(`warn: ${path} is not a JSON object; using defaults\n`);
    return { ok: true, value: { ...DEFAULT_CONFIG } };
  }
  return { ok: true, value: { ...DEFAULT_CONFIG, ...parsed } };
}

export function updateConfig(projectDir, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "patch must be a JSON object" };
  }
  const current = loadConfig(projectDir);
  if (!current.ok) return current;
  const next = { ...current.value, ...patch };
  const path = configPath(projectDir);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, path);
    return { ok: true, value: next };
  } catch (err) {
    return { ok: false, error: `failed to write ${path}: ${err.message}` };
  }
}
```

### Tasks

- [ ] **Step 1: Write failing tests for `loadConfig` and `updateConfig`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  updateConfig,
} from "../../plugins/opencode/scripts/lib/config.mjs";
import { makeTempRepo } from "./helpers.mjs";

test("DEFAULT_CONFIG: stopReviewGate is false", () => {
  assert.equal(DEFAULT_CONFIG.stopReviewGate, false);
});

test("configPath: composes <projectDir>/.claudecode-buddy/opencode/config.json", () => {
  assert.equal(
    configPath("/tmp/x"),
    "/tmp/x/.claudecode-buddy/opencode/config.json",
  );
});

test("loadConfig: returns DEFAULT_CONFIG when file does not exist", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, DEFAULT_CONFIG);
  } finally { cleanup(); }
});

test("loadConfig: merges user values with defaults", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    updateConfig(dir, { stopReviewGate: true });
    const r = loadConfig(dir);
    assert.equal(r.value.stopReviewGate, true);
  } finally { cleanup(); }
});

test("loadConfig: non-JSON file → DEFAULT_CONFIG with warning (no error)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const path = configPath(dir);
    require("node:fs").mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not json {");
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, DEFAULT_CONFIG);
  } finally { cleanup(); }
});

test("loadConfig: JSON-but-not-object → DEFAULT_CONFIG", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const path = configPath(dir);
    require("node:fs").mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "[1,2,3]");
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, DEFAULT_CONFIG);
  } finally { cleanup(); }
});

test("updateConfig: round-trip", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r1 = updateConfig(dir, { stopReviewGate: true });
    assert.equal(r1.ok, true);
    assert.equal(r1.value.stopReviewGate, true);
    const r2 = loadConfig(dir);
    assert.equal(r2.value.stopReviewGate, true);
    const r3 = updateConfig(dir, { stopReviewGate: false });
    assert.equal(r3.value.stopReviewGate, false);
  } finally { cleanup(); }
});

test("updateConfig: rejects non-object patch", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    assert.equal(updateConfig(dir, null).ok, false);
    assert.equal(updateConfig(dir, [1]).ok, false);
    assert.equal(updateConfig(dir, "foo").ok, false);
  } finally { cleanup(); }
});

test("updateConfig: atomic (no .tmp leftovers on success)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    updateConfig(dir, { stopReviewGate: true });
    const cfgDir = join(dir, ".claudecode-buddy", "opencode");
    const entries = require("node:fs").readdirSync(cfgDir);
    assert.equal(entries.filter((e) => e.includes(".tmp.")).length, 0);
  } finally { cleanup(); }
});

test("updateConfig: preserves unrelated keys when patching one", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    // Simulate a future-version config with extra keys.
    const path = configPath(dir);
    require("node:fs").mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ stopReviewGate: false, futureFlag: 42 }));
    const r = updateConfig(dir, { stopReviewGate: true });
    assert.equal(r.value.stopReviewGate, true);
    assert.equal(r.value.futureFlag, 42, "unrelated keys must survive partial update");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests, see failures**

```bash
node --test tests/opencode/config.test.mjs
```

- [ ] **Step 3: Implement `lib/config.mjs`** (use the snippet above).

- [ ] **Step 4: Run tests, verify 10/10 pass.**

- [ ] **Step 5: Commit Phase 1**

```bash
git add plugins/opencode/scripts/lib/config.mjs tests/opencode/config.test.mjs
git commit -m "feat(opencode): lib/config.mjs — workspace plugin config CRUD"
```

---

## Phase 2 — `--style adversarial` flag + prompt template

**Files:**
- Create: `plugins/opencode/prompts/adversarial-review.md`
- Modify: `plugins/opencode/scripts/buddy.mjs:parseReviewArgs` (add `--style` flag)
- Modify: `plugins/opencode/scripts/buddy.mjs:buildReviewPrompt` (load template based on `--style`)
- Modify: `plugins/opencode/scripts/buddy.mjs:runReview` (forward style to dispatcher; suffix role with `-adversarial` when style=adversarial)
- Modify: `tests/opencode/review-cmd.test.mjs`

### Adversarial prompt template

```markdown
You are a hostile reviewer.

Your friendly counterpart looks for bugs to fix and approves when the code seems sound.
Your job is the OPPOSITE: assume the code is broken in ways the friendly reviewer missed.

Hunt for:
- Edge cases that aren't covered (off-by-one, empty inputs, null/undefined, concurrency, locale, error paths).
- Hidden assumptions that will fail in production (resources are unbounded, network never hangs, files always exist, callers always validate).
- Adversarial inputs — what an attacker, a buggy upstream caller, or a malformed config would do.
- Race conditions, TOCTOU windows, and any "atomic" claim that isn't actually atomic at the OS level.
- Silent failure modes — code paths that succeed at the exit-code level but produce no useful effect.

Output the same Markdown findings + JSON trailer format as a friendly review.
The trailer's `verdict` should be `needs-attention` if you find anything actionable, even if it's "only" a Should-Fix.
Do not approve unless you genuinely cannot find an attack vector.
End every blocker title with the failure mode it would cause in production
(e.g., "TOCTOU race in lockfile creation → silent data loss under contention").

You are not paranoid; you are correct.
```

### Tasks

- [ ] **Step 1: Write failing test for `--style adversarial` flag parsing**

```javascript
test("review --style adversarial captured by parser", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--style", "adversarial", "--model", "vendor/m"],
      { OPENCODE_BIN: REVIEW_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    // Friendly default still works without flag.
    assert.equal(result.code, 0);
  } finally { cleanup(); }
});

test("review --style with invalid value rejected with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--style", "ninja"],
      { OPENCODE_BIN: REVIEW_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--style.*friendly|adversarial/i);
  } finally { cleanup(); }
});

test("review --style adversarial routes through role=review-adversarial for session continuity", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    saveSessionId(dir, "scratch", "review-adversarial", "vendor/m", "ses_ADVprior");
    const fixtureLog = join(dir, "fixture-log.ndjson");
    const sessionsFile = join(dir, "mock-sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_ADVprior", updated: 100, directory: dir },
    ]));
    await runCompanion(
      ["review", "--style", "adversarial", "--model", "vendor/m"],
      {
        OPENCODE_BIN: REVIEW_OK_BIN, OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir,
        OPENCODE_FIXTURE_LOG: fixtureLog, OPENCODE_FIXTURE_SESSIONS: sessionsFile,
      },
    );
    const log = readFileSync(fixtureLog, "utf8").trim().split("\n").map(JSON.parse);
    const sessionFlagIdx = log[0].argv.indexOf("--session");
    assert.notEqual(sessionFlagIdx, -1);
    assert.equal(log[0].argv[sessionFlagIdx + 1], "ses_ADVprior",
      "adversarial review must resume from review-adversarial role's stored session, " +
      "NOT review's");
    // The 'review' role's session-id, if any, must NOT have been used.
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests, see failures.**

- [ ] **Step 3: Implement parser additions for `--style`**

```diff
 function parseReviewArgs(rawArgs) {
   const argv = rawArgs.flatMap((a) => splitArgs(a));
-  const out = { scope: "auto", base: "main", model: null, sessionKey: null, reset: false, noSession: false };
+  const out = { scope: "auto", base: "main", model: null, sessionKey: null, reset: false, noSession: false, style: "friendly" };
+  const VALID_STYLES = new Set(["friendly", "adversarial"]);
   for (let i = 0; i < argv.length; i++) {
     const a = argv[i];
     ...
+    } else if (a === "--style") {
+      const v = argv[++i];
+      if (v === undefined) return { ok: false, error: "--style requires a value (friendly|adversarial)" };
+      if (!VALID_STYLES.has(v)) {
+        return { ok: false, error: `--style value must be one of friendly, adversarial — got: ${JSON.stringify(v)}` };
+      }
+      out.style = v;
     } else if (a.startsWith("--")) {
-      return { ok: false, error: `unknown flag: ${a}. Supported: --scope, --base, --model, --session-key, --reset, --no-session.` };
+      return { ok: false, error: `unknown flag: ${a}. Supported: --scope, --base, --model, --session-key, --reset, --no-session, --style.` };
     }
```

- [ ] **Step 4: Implement `buildReviewPrompt` template branching**

```diff
+import { readFileSync as _readFileSync } from "node:fs";
+import { dirname as _dirname, join as _join } from "node:path";
+import { fileURLToPath as _fileURLToPath } from "node:url";
+
+const _PROMPTS_DIR = _join(_dirname(_fileURLToPath(import.meta.url)), "..", "prompts");
+
+function loadStylePrefix(style) {
+  if (style === "friendly") return ""; // baseline behavior unchanged
+  const path = _join(_PROMPTS_DIR, `${style}-review.md`);
+  try {
+    return _readFileSync(path, "utf8") + "\n\n---\n\n";
+  } catch {
+    process.stderr.write(`warn: --style ${style} template missing at ${path}; falling back to friendly\n`);
+    return "";
+  }
+}

 function buildReviewPrompt({ diff, scope, base, style = "friendly" }) {
-  return `<original friendly prompt body using diff/scope/base>`;
+  const stylePrefix = loadStylePrefix(style);
+  return stylePrefix + `<original friendly prompt body using diff/scope/base>`;
 }
```

- [ ] **Step 5: Update `runReview` to forward `style` to `dispatchOpencode`**

```diff
   const prompt = buildReviewPrompt({
     diff: diff.value,
     scope: resolved.value.scope,
     base: resolved.value.base,
+    style: args.style,
   });

   const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;
   const opencodeArgs = ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd];
   if (args.model) opencodeArgs.push("--model", args.model);

   const invocation = await dispatchOpencode({
     binary: cli.binary,
     cwd,
     projectDir,
-    role: "review",
+    role: args.style === "adversarial" ? "review-adversarial" : "review",
     model: args.model,
     prompt,
     opencodeArgs,
     sessionKeyOverride: parsed.value.sessionKey ?? null,
     reset: parsed.value.reset ?? false,
     noSession: parsed.value.noSession ?? false,
   });
```

- [ ] **Step 6: Run tests, verify pass (3 new + existing review tests).**

- [ ] **Step 7: Commit Phase 2**

```bash
git add plugins/opencode/prompts/adversarial-review.md plugins/opencode/scripts/buddy.mjs tests/opencode/review-cmd.test.mjs
git commit -m "feat(opencode): /opencode:review --style adversarial + prompt template"
```

---

## Phase 3 — `/opencode:gate` slash command

**Files:**
- Create: `plugins/opencode/commands/gate.md`
- Modify: `plugins/opencode/scripts/buddy.mjs` — add `gate` subcommand to dispatch
- Create: `tests/opencode/gate-cmd.test.mjs`

The slash command wraps `lib/config.mjs:updateConfig` so users don't have to edit JSON files directly.

### Subcommand semantics

```
node buddy.mjs gate on       → set config.stopReviewGate = true; print confirmation
node buddy.mjs gate off      → set config.stopReviewGate = false; print confirmation
node buddy.mjs gate status   → print current config.stopReviewGate value
```

Default (no arg) is `status`. Unknown args rejected with exit 2.

### `commands/gate.md`

```markdown
---
description: Toggle the opt-in Stop-hook review gate (off by default)
argument-hint: '[on|off|status]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Toggle the workspace-level Stop-hook review gate.

Raw slash-command argument: `$ARGUMENTS`

Run:
\`\`\`bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" gate "$ARGUMENTS"
\`\`\`

Surface the script's stdout verbatim. The script accepts `on`, `off`, `status` (default), and rejects anything else with exit 2.
```

### `runGate` implementation

```javascript
function runGate(rawArgs) {
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const action = (argv[0] ?? "status").toLowerCase();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  if (action === "status") {
    const cfg = loadConfig(projectDir);
    if (!cfg.ok) { process.stderr.write(`${cfg.error}\n`); process.exit(1); }
    process.stdout.write(`Stop-hook review gate: ${cfg.value.stopReviewGate ? "ON" : "OFF"}\n`);
    process.exit(0);
  }

  if (action === "on" || action === "off") {
    const r = updateConfig(projectDir, { stopReviewGate: action === "on" });
    if (!r.ok) { process.stderr.write(`${r.error}\n`); process.exit(1); }
    process.stdout.write(`Stop-hook review gate set to ${action.toUpperCase()}.\n`);
    if (action === "on") {
      process.stdout.write(
        `On the next 'Stop' event (Claude finishes a turn), the gate will run a review of the last ` +
        `assistant message + working-tree diff. Use '/opencode:gate off' to disable.\n`,
      );
    }
    process.exit(0);
  }

  process.stderr.write(`unknown gate action: ${action}. Use: on, off, status.\n`);
  process.exit(2);
}
```

### Dispatch wiring in `buddy.mjs`

Find the existing `if (subcommand === "...")` chain at the bottom of `buddy.mjs` and add a branch for `gate`:

```javascript
} else if (sub === "gate") {
  runGate(rest);
}
```

### Tasks

- [ ] **Step 1: Write failing tests for `runGate`**

```javascript
test("gate status: reports OFF by default", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate", "status"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /OFF/);
  } finally { cleanup(); }
});

test("gate on: sets stopReviewGate true and persists", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    await runCompanion(["gate", "on"], { CLAUDE_PROJECT_DIR: dir });
    const r = loadConfig(dir);
    assert.equal(r.value.stopReviewGate, true);
  } finally { cleanup(); }
});

test("gate off: sets stopReviewGate false and persists", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    updateConfig(dir, { stopReviewGate: true });
    await runCompanion(["gate", "off"], { CLAUDE_PROJECT_DIR: dir });
    const r = loadConfig(dir);
    assert.equal(r.value.stopReviewGate, false);
  } finally { cleanup(); }
});

test("gate (no arg): defaults to status", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /OFF|ON/);
  } finally { cleanup(); }
});

test("gate <unknown>: rejected with exit 2", async () => {
  const result = await runCompanion(["gate", "ninja"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown gate action/i);
});
```

- [ ] **Step 2: Implement runGate dispatch in buddy.mjs.**

- [ ] **Step 3: Create `commands/gate.md`.**

- [ ] **Step 4: Run tests, verify 5/5 pass.**

- [ ] **Step 5: Commit Phase 3**

```bash
git add plugins/opencode/commands/gate.md plugins/opencode/scripts/buddy.mjs tests/opencode/gate-cmd.test.mjs
git commit -m "feat(opencode): /opencode:gate slash command (on|off|status)"
```

---

## Phase 4 — `stop-review-gate-hook.mjs`

**Files:**
- Create: `plugins/opencode/scripts/stop-review-gate-hook.mjs`
- Create: `tests/opencode/stop-gate.test.mjs`

This is the hook script Claude Code invokes on every `Stop` event. It implements three pillars:
1. **Opt-in check** — read config; if `stopReviewGate !== true`, return immediately (no decision emitted; Claude proceeds normally).
2. **Smart-skip** — if the hook input shows the assistant turn produced no actionable changes (no file edits, no tool use beyond `Read`/`Glob`/`Grep`), return without running review. Cheap skip path.
3. **Fail-open** — if the review invocation itself fails (binary missing, timeout, parse error), log a warning to stderr and pass through (no `decision: block`). Codex fails closed; we deliberately fail open so a broken review system doesn't strand the user.

### Hook input contract

Per the codex reference hook (`stop-review-gate-hook.mjs`), the `Stop` hook reads JSON on stdin with three fields we can rely on:

```json
{
  "session_id": "claude-session-uuid",
  "cwd": "/path/to/project",
  "last_assistant_message": "I've finished the implementation. Tests are passing."
}
```

`tool_uses[]` is **NOT** a documented or codex-confirmed field; it was an unverified assumption in plan 003 round 1. Smart-skip uses `git` state instead (see below).

### Smart-skip rule (revised after round-1 review)

Authoritative signal: **`git` working-tree state**. The turn is "actionable" if AND ONLY IF the workspace has any of:

1. Modified tracked files: `git diff --quiet HEAD` returns non-zero.
2. Staged changes: `git diff --quiet --cached` returns non-zero.
3. Untracked files (excluding gitignored): `git ls-files --others --exclude-standard` returns any output.

If all three checks come up clean (no changes), smart-skip and return without running review.

**Plus a meta-skip:** if the only changes are under `.claudecode-buddy/` (the dispatcher's own session-id writes during plan/code review work), the gate skips — reviewing the reviewer's session-state file isn't useful and would double API cost during review-heavy sessions. Implementation: filter the `git status --porcelain` output, skip if all entries match `^.. \.claudecode-buddy/`.

**Distinction between git-stuck and non-git:** `execFileSync` failures come in two flavors. ENOENT (git not installed) or "not a git repository" → workspace genuinely has no git state, so the gate runs (the reviewer sees the diff via whatever non-git mechanism is available). Other errors (timeout, `.git/index.lock` contention, permission denied) mean git itself is wedged — don't run a review whose prompt explicitly tells the model to run `git diff HEAD` and `git status` (the review would fail the same way the smart-skip check failed). The hook logs the error to stderr and skips, leaving the user to recover.

**Removed in round 2:** an earlier draft also soft-skipped on assistant-message regex matching `dispatching opencode|opencode review|opencode run`. Round-2 review correctly flagged this as false-positive-prone (a turn that DID make code changes but happened to mention review-dispatch in the message would falsely skip). The meta-skip on `.claudecode-buddy/` already handles the dominant reviewer-dispatching case (when the dispatcher's only working-tree change is the session-id file).

### Verdict handling

After invoking review via `dispatchOpencode` with `role: "stop-gate"`:
- If invocation fails (`!ok`) OR result text is empty: log warning, fail open (no block).
- Parse the verdict trailer (reuse `extractTrailer` from `lib/trailer.mjs`).
- If verdict === "approve": pass through.
- If verdict === "needs-attention": emit `{decision: "block", reason: <findings + first 3 blockers>}` to stdout. Claude Code blocks the Stop and surfaces the reason to Claude.
- If trailer parse fails: log warning, fail open.

### Tasks

- [ ] **Step 1: Write failing tests for the hook's three pillars**

Tests use `child_process.spawn` to invoke the hook script directly with stdin JSON.

```javascript
test("stop-gate: returns silently when stopReviewGate is OFF (default)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "done",
      tool_uses: [{ tool: "Edit" }],
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "no JSON decision emitted when gate is OFF");
  } finally { cleanup(); }
});

test("stop-gate: smart-skip when working tree is clean (no git changes)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir); // git init + initial commit; clean working tree
    updateConfig(dir, { stopReviewGate: true });
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Here's how the function works...",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "smart-skip must NOT emit a block decision");
    assert.match(result.stderr, /skipping.*no.*changes/i);
  } finally { cleanup(); }
});

test("stop-gate: actionable turn (working tree dirty) → review invoked → approve passes", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    // Add a file to make the working tree dirty.
    writeFileSync(join(dir, "new.js"), "console.log('hi');\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "I added new.js.",
    }, { OPENCODE_BIN: REVIEW_OK_BIN });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "approve verdict must NOT block");
  } finally { cleanup(); }
});

test("stop-gate: meta-skip when only changes are under .claudecode-buddy/", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    // Simulate dispatcher having written a session-id during a review turn.
    mkdirSync(join(dir, ".claudecode-buddy", "opencode", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".claudecode-buddy", "opencode", "sessions", "plan-001-review-vendor-m.session-id"), "ses_xyz");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Reviewed the diff.",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "meta-skip must NOT emit a block decision");
    assert.match(result.stderr, /\.claudecode-buddy.*self-edit/i);
  } finally { cleanup(); }
});

// (Round-2 revision dropped the soft-skip-on-assistant-message-regex behavior;
// no test for it. The meta-skip on `.claudecode-buddy/`-only changes is the
// only reviewer-dispatching skip path.)

test("stop-gate: working tree dirty AND assistant mentions review-dispatch → gate STILL runs", async () => {
  // Round-3 review (codex + deepseek): the soft-skip was dropped because it
  // false-positives on real changes. Verify the gate runs anyway.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "new.js"), "// real edits\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Dispatching opencode review for plan-001 round 2...",
    }, { OPENCODE_BIN: REVIEW_OK_BIN });
    // Approve fixture → no block. Critical: the gate RAN (didn't soft-skip).
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "approve fixture → no block decision");
    assert.doesNotMatch(result.stderr, /dispatching opencode reviewers/i,
      "round-2 dropped the soft-skip; this stderr message must not appear");
  } finally { cleanup(); }
});

test("stop-gate: needs-attention verdict → emit {decision:'block', reason}", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "broken.js"), "syntax error here\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    }, { OPENCODE_BIN: REVIEW_NEEDS_ATTN_BIN });
    assert.equal(result.code, 0);
    const decision = JSON.parse(result.stdout.trim());
    assert.equal(decision.decision, "block");
    assert.ok(decision.reason.length > 0);
  } finally { cleanup(); }
});

test("stop-gate: review invocation fails → fail OPEN (no block)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "x.js"), "x\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    }, { OPENCODE_BIN: "/nonexistent/binary" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "",
      "fail-open: broken review system must NOT block the user; only log warning");
    assert.match(result.stderr, /failing open/i);
  } finally { cleanup(); }
});

test("stop-gate: trailer-parse failure → fail OPEN", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "x.js"), "x\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    }, { OPENCODE_BIN: REVIEW_NO_TRAILER_BIN });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /trailer.*parse|failing open/i);
  } finally { cleanup(); }
});

test("stop-gate: non-git workspace → gate runs (treated as actionable)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    // No setupRepo() — dir is not a git repo.
    updateConfig(dir, { stopReviewGate: true });
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    }, { OPENCODE_BIN: REVIEW_OK_BIN });
    // Gate runs (not skipped) and approve fixture emits ok verdict → no block.
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Implement `stop-review-gate-hook.mjs` (revised after round-1 review)**

Skeleton — uses **`git` state** (not `tool_uses`) as the actionable signal, inlines the `buildStopGatePrompt` helper, drops the unused `workspace-root.mjs` import, adds top-level uncaughtException + unhandledRejection handlers (fail-open):

```javascript
#!/usr/bin/env node
// CRITICAL ESM ORDERING (per plan 002 supervisor.mjs precedent + plan 003
// round-2 review): the fail-open handlers MUST be registered BEFORE any of
// our own imports load — those CAN throw at module-load time on syntax
// errors, missing files, or circular deps. ESM hoists static `import`
// statements to the top of the module body, so we use only built-in static
// imports (which can never fail), register the handlers, then `await
// import(...)` our own modules dynamically.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_TIMEOUT_MS = 15 * 60 * 1000; // outer ceiling; inner dispatcher timeout (5min) fires first

// Top-level fail-open handlers — must register BEFORE any code that could throw.
// Codex chose fail-closed; we deliberately fail open so a broken hook doesn't
// strand the user. Threat model: this is an advisory development gate, NOT a
// security control. See D-011 for the full rationale.
process.on("uncaughtException", (err) => {
  process.stderr.write(`stop-gate: uncaughtException (${err.message}); failing open\n`);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`stop-gate: unhandledRejection (${err?.message ?? err}); failing open\n`);
  process.exit(0);
});

// Dynamic imports for our own modules — handlers are registered, so any
// throws here trigger the fail-open path.
const { loadConfig } = await import("./lib/config.mjs");
const { dispatchOpencode } = await import("./lib/review-dispatch.mjs");
const { detectOpencode } = await import("./lib/cli-detection.mjs");
const { extractTrailer } = await import("./lib/trailer.mjs");

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  } catch {}
  return {};
}

// Authoritative actionable-turn signal: git working-tree state.
// Returns "skip" with reason if no actionable changes; "go" otherwise.
function checkActionable(cwd) {
  // Pre-check .git existence. Cheap, doesn't depend on stderr capture for
  // distinguishing non-git from wedged-git (which is fragile — execFileSync
  // with stdio: ignore drops stderr, so we can't reliably detect "not a git
  // repository" from err.message alone, per round-3 codex review).
  if (!existsSync(joinPath(cwd, ".git"))) {
    return { go: true, reason: "non-git workspace; gate runs without git-state filter" };
  }
  let porcelain;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    });
  } catch (err) {
    // .git exists but git itself failed (ENOENT for the binary, timeout,
    // .git/index.lock contention, permission denied). Don't run a review
    // whose prompt tells the model to query the same broken git.
    const code = err.code ?? "";
    const stderr = (err.stderr ?? "").toString().slice(0, 80);
    if (code === "ENOENT") {
      return { go: false, reason: "git binary not installed; skipping review (cannot read diff)" };
    }
    return { go: false, reason: `git state check failed (${code}: ${stderr}); skipping rather than running review on wedged git` };
  }
  const lines = porcelain.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { go: false, reason: "no working-tree, staged, or untracked changes" };
  // Meta-skip: only changes are under .claudecode-buddy/ (the dispatcher's
  // own session-id writes during plan/code review work). Reviewing the
  // reviewer's session-state file isn't useful and would double API cost.
  if (lines.every((l) => /^.. \.claudecode-buddy\//.test(l))) {
    return { go: false, reason: "only .claudecode-buddy/ session-id changes (dispatcher self-edit)" };
  }
  return { go: true, reason: `${lines.length} working-tree change(s)` };
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

function logWarn(msg) {
  process.stderr.write(`stop-gate: ${msg}\n`);
}

// Read the templated prompt from disk; fall back to inline only when the
// file is missing (partial install or pre-Phase-5 dev state). Other errors
// (permission denied, EIO, etc.) propagate to the caller, which fail-opens
// via the top-level uncaughtException handler — better to surface those
// than silently mask them with the inline default.
function buildStopGatePrompt(cwd, lastMsg) {
  const PROMPTS_DIR = joinPath(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
  const templatePath = joinPath(PROMPTS_DIR, "stop-review-gate.md");
  let template;
  try {
    template = readFileSync(templatePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      template = INLINE_STOP_GATE_PROMPT;
    } else {
      throw err; // propagate to fail-open via uncaughtException
    }
  }
  const snippet = lastMsg.length > 0
    ? `\n\nPrevious Claude response:\n${lastMsg.slice(0, 8000)}\n`
    : "\n\n(no last assistant message provided)\n";
  return template + snippet;
}

const INLINE_STOP_GATE_PROMPT = [
    "You are a code-review gate.",
    "",
    "The user just finished a Claude Code turn. Review the assistant's last message AND the working-tree state. If this is a git repo, run `git diff HEAD` and `git status` to see what actually changed; if it's not (no `.git/` directory), inspect files directly via Read/Glob/Grep — the file system itself is your source of truth.",
    "",
    "Look for: claims that don't match reality (\"tests pass\" → tests must exist + actually run + actually pass); obvious diff issues (incomplete edits, broken imports, syntax errors); unacknowledged side effects (commits, pushes, deletions).",
    "",
    "Output Markdown findings followed by a JSON trailer:",
    "```json",
    '{"verdict": "approve" | "needs-attention", "blockers": [string]}',
    "```",
    "",
    "approve only when the assistant's claims match reality. needs-attention for any mismatch — be honest. Three findings max.",
].join("\n");

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectDir = cwd;

  const cfg = loadConfig(projectDir);
  if (!cfg.ok) { logWarn(`config load failed: ${cfg.error}; failing open`); process.exit(0); }
  if (!cfg.value.stopReviewGate) process.exit(0); // opt-out path: gate is OFF

  const lastMsg = String(input.last_assistant_message ?? "");
  const action = checkActionable(cwd);
  if (!action.go) {
    logWarn(`skipping gate (${action.reason})`);
    process.exit(0);
  }

  const cli = detectOpencode({ env: process.env });
  if (!cli.installed) { logWarn(`opencode not installed; failing open`); process.exit(0); }

  const prompt = buildStopGatePrompt(cwd, lastMsg.slice(0, 8000));

  let result;
  try {
    result = await Promise.race([
      dispatchOpencode({
        binary: cli.binary, cwd, projectDir,
        role: "stop-gate", model: null, prompt,
        opencodeArgs: ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("hook outer timeout")), HOOK_TIMEOUT_MS)),
    ]);
  } catch (err) {
    logWarn(`review failed (${err.message}); failing open`);
    process.exit(0);
  }

  if (!result.ok || !(result.text ?? "").trim()) {
    logWarn(`review returned no text (${result.error ?? "empty body"}); failing open`);
    process.exit(0);
  }

  const trailer = extractTrailer(result.text);
  if (!trailer.ok) {
    logWarn(`trailer parse failed (${trailer.error}); failing open`);
    process.exit(0);
  }

  if (trailer.value.verdict === "approve") process.exit(0);

  // verdict === "needs-attention" → block Claude's stop with the findings.
  const blockers = (trailer.value.blockers ?? []).slice(0, 3);
  const reason = `Stop-hook review gate found ${blockers.length || "open"} concern(s):\n` +
    blockers.map((b) => `- ${b}`).join("\n") +
    `\n\nFull review:\n${result.text}`;
  emitBlock(reason);
}

main().catch((err) => {
  logWarn(`unexpected main() error (${err.message}); failing open`);
  process.exit(0);
});
```

**Timeout layering** (per round-1 review): inner dispatcher timeout (`invokeOpencodeRaw` default = 5min) fires before the outer 15min hook timeout. On inner timeout, `dispatchOpencode` returns `{ok:false, error}` → fail-open path. The outer 15min ceiling is a hard guard for cases where the inner timeout itself misbehaves; not the operational bound.

- [ ] **Step 3: Add helper fixtures and the prompt template (Phase 5).**

- [ ] **Step 4: Run hook tests, verify pass (8 tests covering: clean-tree skip, dirty-tree gate runs, meta-skip on .claudecode-buddy/, dispatch-message-but-still-runs, needs-attention block, fail-open on missing binary, fail-open on trailer-parse failure, non-git workspace).**

- [ ] **Step 5: Commit Phase 4**

```bash
git add plugins/opencode/scripts/stop-review-gate-hook.mjs tests/opencode/stop-gate.test.mjs tests/opencode/fixtures/mock-opencode-review-needs-attention.mjs tests/opencode/fixtures/mock-opencode-review-no-trailer.mjs
git commit -m "feat(opencode): stop-review-gate-hook.mjs — opt-in + smart-skip + fail-open"
```

---

## Phase 5 — Hooks.json registration + prompt template

**Files:**
- Modify: `plugins/opencode/hooks/hooks.json` (add Stop entry)
- Create: `plugins/opencode/prompts/stop-review-gate.md`

### `hooks.json` Stop entry

```diff
   "hooks": {
     "SessionStart": [...],
-    "SessionEnd": [...]
+    "SessionEnd": [...],
+    "Stop": [
+      {
+        "hooks": [
+          {
+            "type": "command",
+            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
+            "timeout": 900
+          }
+        ]
+      }
+    ]
   }
```

900-second timeout matches codex's. The hook itself short-circuits on opt-out / smart-skip / fail-open, so the timeout only matters for the review-running path — which IS bounded by the dispatcher's own opencode timeout.

### `prompts/stop-review-gate.md`

```markdown
You are a code-review gate.

The user just finished a Claude Code turn. The assistant claimed they completed work. Your job is to verify that claim against the working tree.

Review the assistant's last message AND the working-tree state. If this is a git repo, run `git diff HEAD` and `git status` to see what actually changed; if it's not (no `.git/` directory), inspect files directly via Read/Glob/Grep — the file system itself is your source of truth.

Look for:

- The assistant claimed to do X. Was X actually done? (Tests passing claim → tests must exist + actually run + actually pass.)
- The diff has obvious issues the assistant should have caught (incomplete edits, syntax errors, wrong variable names, broken imports).
- Tool-use side effects that weren't acknowledged (commits, pushes, deletions).

Output Markdown findings followed by a JSON trailer:

\`\`\`json
{"verdict": "approve" | "needs-attention", "blockers": [string]}
\`\`\`

`approve` only when the assistant's claims match reality and the diff has no obvious issues.
`needs-attention` for any mismatch — be honest, this is the gate's job.
Keep it short — three findings max.
```

### Tasks

- [ ] **Step 1: Update `hooks.json`.**
- [ ] **Step 2: Create `prompts/stop-review-gate.md`.**
- [ ] **Step 3: End-to-end smoke test:** run a real `Stop` event in a sandbox repo with the gate ON; verify the hook fires.
- [ ] **Step 4: Commit Phase 5**

```bash
git add plugins/opencode/hooks/hooks.json plugins/opencode/prompts/stop-review-gate.md
git commit -m "feat(opencode): register Stop-hook + ship gate prompt template"
```

---

## Phase 6 — Slash command + subagent + CLAUDE.md updates

**Files:**
- Modify: `plugins/opencode/commands/review.md` (add `--style` to argument-hint + new "Adversarial review" subsection)
- Modify: `plugins/opencode/agents/opencode-review.md` (forward `--style` through subagent invocations)
- Modify: `CLAUDE.md` (note: gate is opt-in, dual reviewers can be `friendly + adversarial`)

### Tasks

- [ ] **Step 1: Update `commands/review.md` argument-hint and add "Adversarial review" subsection.**
- [ ] **Step 2: Update `agents/opencode-review.md` to mention `--style adversarial`.**
- [ ] **Step 3: Update CLAUDE.md "Plan review gate" section: dual reviewers can optionally use Codex + opencode/deepseek-v4-pro WITH `--style adversarial` to get a more skeptical second opinion.**
- [ ] **Step 4: Commit Phase 6**

```bash
git add plugins/opencode/commands/review.md plugins/opencode/agents/opencode-review.md CLAUDE.md
git commit -m "docs(opencode): document --style adversarial in slash command + subagent + CLAUDE.md"
```

---

## Phase 7 — Documentation, version bump, post-execution report

**Files:**
- Modify: `plugins/opencode/.claude-plugin/plugin.json` (0.3.0 → 0.4.0)
- Modify: `plugins/opencode/CHANGELOG.md` (0.4.0 entry)
- Modify: `plugins/opencode/README.md` (phasing + new "Stop-hook review gate" + "Adversarial review" sections)
- Modify: `docs/architecture/decisions.md` (D-011 — Stop-hook review gate semantics)
- Modify: `docs/plans/003-review-experience.md` (post-execution report)

### D-011 (architecture decision)

```markdown
## D-011 — Stop-hook review gate is opt-in, fails open, smart-skips read-only turns

**Decided in:** plan 003 (`docs/plans/003-review-experience.md`).

The Stop-hook review gate is enabled per workspace via `.claudecode-buddy/opencode/config.json`'s `stopReviewGate` flag (default `false`). Toggle via `/opencode:gate on|off|status`. When ON, every Stop event triggers a review of the last assistant message + working-tree diff via `dispatchOpencode` with `role: "stop-gate"`. Verdict `needs-attention` → emit `{decision: "block", reason}` to Claude Code (forces Claude to address); verdict `approve` → pass through.

Three behaviours that diverge from codex's analogous hook:

1. **Smart-skip read-only turns via git state (not `tool_uses` parsing).** If `git status --porcelain` shows no working-tree, staged, or untracked changes, skip the review. Codex doesn't smart-skip; it runs every Stop. We add this to make the gate tolerable for daily use. The original plan-003 design used hook-payload `tool_uses` parsing, which round-1 review correctly flagged as unverified (codex's reference hook never accesses that field). The git-state signal is authoritative, doesn't depend on hook payload shape, and matches the actual question we want answered ("did code change?"). Plus a meta-skip when changes are limited to `.claudecode-buddy/` (dispatcher's own session-id writes during review-of-reviewers turns).

2. **Fail open on review-system errors.** If the review invocation itself fails (binary missing, timeout, parse error), log a warning to stderr and pass through (no `decision: block`). Codex fails closed (blocks).

   **Threat model for the fail-open choice:** the Stop-hook gate is an **advisory development workflow safeguard**, NOT a security control. Its job is to catch the dominant Claude failure mode of "claimed work done but didn't actually verify" — a productivity issue, not an exploitation vector. Failing open preserves user productivity when the review system itself is misconfigured (opencode binary missing, model API outage, log-format change breaking the trailer parser). For a genuine security gate (e.g., "block commits that fail license-compliance check"), fail-closed is correct — but plan 003 ships an advisory gate, and a broken advisory gate that strands the user is worse than a missing one. The hook explicitly logs warnings to stderr on every fail-open path so users notice when the gate isn't running.

3. **Opt-in via slash command + config file.** `/opencode:gate on|off|status` wraps the file edit. Codex requires direct config-file editing. The slash command makes the toggle discoverable.

Why opt-in (not on by default): every-turn review is expensive (model latency + tokens). Default on would be aggressive for users who haven't configured opencode for the workload. The user explicitly opts in when they want the safety net.

Why a workspace config file (not env var): persistence across Claude Code sessions; survives editor restarts; visible to other tooling.

D-011 also establishes a workspace-config convention: each plugin owns `<project>/.claudecode-buddy/<plugin>/config.json` for runtime settings. Future plugins/plans add fields to their own config without affecting other plugins.
```

### CHANGELOG 0.4.0 entry

```markdown
## 0.4.0 — Adversarial-style review + opt-in Stop-hook gate

Implemented per `docs/plans/003-review-experience.md`.

### Added
- `--style <friendly|adversarial>` flag on `/opencode:review`. Default `friendly` (current v0.3.0 behavior). `--style adversarial` prepends the adversarial prompt template (`prompts/adversarial-review.md`) and routes session continuity through `role: review-adversarial` (distinct tuple from `review`). Backwards-compatible — no migration needed for existing usage.
- Opt-in Stop-hook review gate. When enabled, every Claude Code `Stop` event runs a review of the last assistant message + working-tree diff via the dispatcher; `needs-attention` verdicts block Claude's stop with `{decision:"block", reason:...}`. Smart-skips read-only turns. Fails open on review-system errors.
- `/opencode:gate on|off|status` slash command — workspace toggle for the Stop-hook gate.
- `lib/config.mjs` — workspace plugin config CRUD (`<project>/.claudecode-buddy/opencode/config.json`).
- `prompts/adversarial-review.md` — hostile-perspective system prompt template.
- `prompts/stop-review-gate.md` — Stop-hook gate prompt template.
- D-011 — Stop-hook review gate is opt-in, fails open, smart-skips read-only turns. Establishes the workspace-config-file convention.

### Changed
- `parseReviewArgs` accepts `--style friendly|adversarial`. Unknown values rejected with exit 2.
- `runReview` forwards style to `dispatchOpencode` and uses `role: "review-adversarial"` when style=adversarial.

### Test counts
- Plan 002 baseline: 205 tests.
- Plan 003 adds: ~26 (config: 10, gate-cmd: 5, --style: 3, stop-gate: 8).
- v0.4.0: ~225 tests pass.

### Deferred to future plans
- Per-session env-var override for the gate (`OPENCODE_BUDDY_STOP_GATE=off`) — plan 005+ if usage shows the workspace flag is too coarse.
- macOS parity for `pidIsOurSupervisor` and `--task-file` TOCTOU defense — plan 004.
- `flock(2)`-backed serialization for `lib/jobs.mjs:updateJob` and the session lock — plan 005.
- `--task` stdin-as-prompt support — plan 004.
```

### Tasks

- [ ] **Step 1: Bump plugin.json version 0.3.0 → 0.4.0.**
- [ ] **Step 2: Append CHANGELOG 0.4.0 entry.**
- [ ] **Step 3: Update README:**
  - Phasing: `v0.4.0 (this release)` = adversarial-review style + Stop-hook gate; `v0.5.0 (plan 004)` = macOS parity + stdin-as-prompt.
  - New "Adversarial review" section: `--style adversarial`, prompt template, role-suffix continuity, dual-reviewer pairing.
  - New "Stop-hook review gate" section: opt-in mechanism, `/opencode:gate`, smart-skip behavior, fail-open semantics, recovery guidance.
- [ ] **Step 4: Add D-011 to `docs/architecture/decisions.md`.**
- [ ] **Step 5: Append post-execution report to this plan file.**
- [ ] **Step 6: Run full test suite.**
- [ ] **Step 7: Commit Phase 7.**

---

## Codex review summary

### Round 1 (2026-05-04) — `verdict: needs-attention`

**2 blockers + 4 should-fix + 4 nice-to-have.** All addressed in revision (see below).

**Blockers (resolved):**

1. **`tool_uses` in Stop hook stdin payload is unverified.** Codex's reference hook reads only `session_id`, `last_assistant_message`, `cwd` — never `tool_uses`. Plan 003 asserted it without spike-verifying.
   → **Resolution:** smart-skip redesigned to use `git diff --quiet HEAD` + `git diff --quiet --cached` + `git ls-files --others --exclude-standard` as the authoritative signal. If the working tree has no uncommitted, staged, or untracked changes, skip the gate. Independent of hook payload fields we can't verify; matches the dominant case (gate cares whether code changed, not which tools Claude used).

2. **Smart-skip can falsely skip real changes.** Same root cause as #1.
   → **Resolution:** same fix — `git status` is authoritative.

**Should-fix (resolved):**

- Inner timeout (5min via `invokeOpencodeRaw`) fires before outer 15min hook timeout. → **Resolution:** documented in Phase 4 + D-011: inner fires first → review error → fail-open path (no block). Outer is a hard ceiling, not the operational bound.
- Fail-open rationale needs explicit docs. → **Resolution:** D-011 expanded with explicit threat model ("advisory gate for development workflows, not a security control"); fail-open prevents a broken review system from stranding the user.
- Phase 4 references undefined `buildStopGatePrompt` + `workspace-root.mjs`. → **Resolution:** inlined `buildStopGatePrompt` in Phase 4 skeleton; removed the bogus `workspace-root.mjs` import (cwd from hook input IS the workspace root).
- Concurrent Claude Code sessions race on `(key, "stop-gate", model)` session. → **Resolution:** documented explicitly — dispatcher's lock-degraded-mode handles the race correctly; the second session's gate runs without continuity but doesn't corrupt the first's stored id.

**Nice-to-have (no action needed):**
- `review-adversarial` survives sanitisation cleanly (confirmed: dashes legal in `SAFE_COMPONENT_RE`).
- Conversation-level recursion documented (no tool-call recursion).
- Parallel session histories for `review` vs `review-adversarial` are intentional — Phase 7 README adds an explicit note.
- Gate fires during reviewer-dispatching turns. → **Resolution:** added a heuristic to skip when the only working-tree changes are under `.claudecode-buddy/` (session-id files the dispatcher writes during its own work) OR when assistant message contains `dispatching opencode|opencode review|opencode run` markers.

### Round 2 (2026-05-04) — `verdict: needs-attention`

**1 BLOCKER + 4 should-fix.** All addressed in revision below.

**Blocker (resolved):**

1. **uncaughtException/unhandledRejection handlers miss static import failures.** Same module-load gap pattern as plan 002's supervisor.mjs round-4 review. ESM hoists static imports to before module-body code → handlers register AFTER imports evaluate → an import that throws at module-load time fires before handlers exist.
   → **Resolution:** restructured the hook with the proven plan-002 supervisor.mjs pattern: static imports of `node:fs`, `node:child_process`, `node:path`, `node:url` ONLY (built-ins cannot fail at module load); register `uncaughtException` + `unhandledRejection` handlers in module body; then `await import(...)` for own modules (`config.mjs`, `review-dispatch.mjs`, `cli-detection.mjs`, `trailer.mjs`). Throws during own-module load now hit the fail-open handlers.

**Should-fix (resolved):**

- Edited-then-reverted edge case (working tree clean despite assistant claiming edits). → **Acknowledged but no fix:** deepseek round-2 verifies this is correctly handled — clean tree = nothing to review = correct skip. Codex's concern was about "claim verification," but if the diff is empty, there's nothing for the reviewer to verify against; the gate's job is to catch claim/diff mismatches, and a clean diff naturally short-circuits.
- Git-stuck conflated with non-git workspace. → **Resolution:** `checkActionable` now distinguishes `ENOENT`/`"not a git repository"` (legitimately non-git → gate runs) from other errors (git wedged → log + skip rather than running review against wedged git that the prompt instructs the model to query).
- Soft-skip regex false-positive on assistant-message review-dispatch markers. → **Resolution:** soft-skip dropped entirely. Meta-skip on `.claudecode-buddy/`-only changes already handles the dominant reviewer-dispatching case (when the dispatcher's only working-tree write is the session-id file).
- Phase 4 buildStopGatePrompt inlined but Phase 5 ships templated version → divergence between the two. → **Resolution:** hook reads `prompts/stop-review-gate.md` via `readFileSync` with the inline string as a safety-net fallback when the file is missing. Single source of truth for content (the template); inline is purely defensive.

### Round 3 (2026-05-04) — `verdict: needs-attention`

**2 NEW blockers + 1 should-fix.** All addressed in this revision.

**Blockers (resolved):**

1. **Git-stuck non-git detection still broken.** `execFileSync("git", ..., { stdio: ["ignore", "pipe", "ignore"] })` ignores stderr, so `err.message` doesn't contain git's "not a git repository" fatal text. The regex `/not a git repository/i.test(msg)` never matched → non-git workspaces fell into the wedged-git skip path.
   → **Resolution:** pre-check `existsSync(joinPath(cwd, ".git"))` BEFORE spawning git. If `.git` doesn't exist, gate runs (non-git workspace). If it exists but git fails, the catch correctly classifies as "wedged git, skip with log." Doesn't depend on stderr capture for distinguishing.

2. **Stale soft-skip test still in the plan** (Phase 4 test "soft-skip when assistant message indicates reviewer-dispatch"). The hook skeleton dropped this behavior in round 2, but the test asserting it still expected the skip. TDD execution would either fail or force the dropped behavior back in.
   → **Resolution:** test rewritten to assert the OPPOSITE — "working tree dirty AND message mentions review-dispatch → gate STILL runs (no soft-skip)." Asserts the gate runs to the approve verdict and doesn't emit the dispatched-skip stderr message.

**Should-fix (resolved):**

- `readFileSync` fallback for the prompt template caught ANY error → triggers fallback on permission errors, etc.
   → **Resolution:** narrowed catch to `err.code === "ENOENT"` (file truly missing). Other errors propagate to the top-level `uncaughtException` handler, which fail-opens. Better to surface non-missing-file errors than silently mask them with the inline default.

### Round 4 (2026-05-04) — `verdict: needs-attention`

**1 trivial blocker.**

1. **`existsSync` used in `checkActionable` but not imported** in the Phase 4 skeleton's `node:fs` import line.
   → **Resolution:** added `existsSync` to the import: `import { readFileSync, existsSync } from "node:fs"`. One-line fix.

### Round 5 (2026-05-04) — `verdict: approve` ✅

All round-4 fixes verified clean. No new blockers. Plan ready for implementation.

## Opencode review summary

### Round 5 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve` ✅

All round-4 fixes (existsSync import + non-git prompt fallback) verified clean. 1 stale test-count claim ("stop-gate: 6" → corrected to 8) was the only nit. Plan ready for implementation.

### Round 4 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: needs-attention`

**1 BLOCKER (same as Codex round-4) + 1 should-fix.**

**Blocker (resolved):**
- `existsSync` used but not imported. Same as Codex round-4. → `import { readFileSync, existsSync } from "node:fs"`.

**Should-fix (resolved):**
- Non-git workspace prompt mismatch: `INLINE_STOP_GATE_PROMPT` instructed the model to "run `git diff HEAD` and `git status`" — would fail in a non-git repo. → **Resolution:** prompt now says "If this is a git repo, run git diff/status; if not (no `.git/`), inspect files via Read/Glob/Grep tools." Phase 5 template updated to match.

### Round 3 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve` ✅

**0 BLOCKERS. 1 should-fix + 2 nice-to-have.**

**Verified resolutions (all clean):**
- Module-load gap → static-builtins + handlers + dynamic-imports pattern. ✅
- checkActionable ENOENT/non-git-repo distinction → ✅ (after round-3 revision adds .git pre-check, the stderr-capture issue is moot).
- Soft-skip on assistant-message regex DROPPED in hook skeleton. ✅
- buildStopGatePrompt reads template via readFileSync with inline fallback. ✅

**Should-fix (also flagged by Codex round-3 → resolved):**
- Stale soft-skip test that contradicted the dropped behavior → test rewritten to assert the gate STILL runs when message mentions dispatch + tree is dirty.

**Nice-to-have:**
- Test count claim updated from "6 tests" to actual count (8).
- Stale "OR when assistant message contains review-dispatch markers" reference in Codex round-1 resolution → cosmetic; left as historical record of the soft-skip concept that was later dropped.

### Round 2 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve` ✅

**0 BLOCKERS. 2 should-fix + 2 nice-to-have** — all addressed in this revision.

**Confirmed resolutions of round-1 items:** `tool_uses` → `git status --porcelain`; `resolveWorkspaceRoot` import removed; inner/outer timeout layering documented; fail-open threat model in D-011; concurrent-session race documented; gate-during-reviewer-dispatching meta-skip + (later removed) soft-skip.

**Should-fix (both resolved in this round-2 revision):**

- **Inline `buildStopGatePrompt` never reads Phase 5's template** → resolved: hook now reads `prompts/stop-review-gate.md` via `readFileSync` with inline fallback. Phase 5 is canonical; inline is safety-net.
- **uncaughtException/unhandledRejection registered AFTER local module imports** (module-load gap) → resolved: restructured to static-builtin-imports + handler registration + dynamic-await-imports pattern (matches plan-002 supervisor.mjs).

**Nice-to-have (both addressed in this round-2 revision):**

- `checkActionable` catch reason misleading for non-"no git" failures → resolved: ENOENT/not-a-git-repo distinguished from other errors.
- Meta-skip regex false-negatives on rename/quoted paths → minor; documented as "extremely unlikely inside `.claudecode-buddy/`; safe direction (gate runs unnecessarily)."

### Round 1 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: needs-attention`

### BLOCKERS

**1. [BLOCKER] `resolveWorkspaceRoot` from `./lib/workspace-root.mjs` does not exist** (Phase 4 skeleton, line 748)
The hook skeleton imports `{ resolveWorkspaceRoot } from "./lib/workspace-root.mjs"` with a comment saying "existing helper", but `plugins/opencode/scripts/lib/workspace-root.mjs` does not exist anywhere in the workspace. No other file in `scripts/lib/` exports this function. The hook already derives `projectDir` from `input.cwd` (line 788), so this import is unused — but as written, the hook would crash at import time. Fix: remove the import, or define the file in Phase 1 alongside `config.mjs`.

**2. [BLOCKER] `tool_uses` in Stop-hook stdin payload is unverified** (Phase 4, lines 597–610, 613–618)
The smart-skip heuristic depends entirely on `tool_uses[]` being present in the Claude Code Stop hook's stdin JSON. The plan claims "(Exact field names verified at implementation time against the codex hook's `readHookInput()` contract.)" but the reference codex hook (`~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/stop-review-gate-hook.mjs`) reads only `last_assistant_message`, `session_id`, and `cwd` — it never accesses `tool_uses`. Without `tool_uses`, the smart-skip degrades to the `ACTIONABLE_MESSAGE_RE` regex on `last_assistant_message`, which is both false-negative-prone (a turn that made edits but the assistant didn't phrase it as "I edited X") and false-positive-prone (a read-only turn where the assistant happens to mention changes from a prior turn). Fix: spike-verify the actual Stop-hook stdin payload from Claude Code documentation or a test hook before implementing. If `tool_uses` is absent, redesign the smart-skip to use `git diff --stat` or omit it.

### SHOULD-FIX

**3. [SHOULD-FIX] `ACTIONABLE_BASH_RE` has incomplete verb coverage** (Phase 4 skeleton, line 756)
The regex catches only `git commit|push|add` but misses other mutating git subcommands (`stash push`, `tag`, `rebase`, `merge`, `checkout -b`, `cherry-pick`, `reset`). The npm/pnpm patterns catch only `install|publish` but miss `npm test`, `npm run build`, `pnpm run build` — all of which can produce side effects (writing to `dist/`, filesystem changes). Fix: either widen the alternation to catch any Bash with a mutating git subcommand and any `npm/pnpm run`/`test`/`build` invocation, or complement with a "known-read-only" exclusion list (e.g., only `git status|diff|log --oneline`, `npm ls`, `pnpm ls`) as the safer direction.

**4. [SHOULD-FIX] `buildStopGatePrompt` is called but not defined in the hook skeleton** (Phase 4 skeleton, line 802)
The skeleton references `buildStopGatePrompt(cwd, lastMsg)` but never defines it. The prompt template is created in Phase 5 (`prompts/stop-review-gate.md`), so the implementation should either read the template file with `readFileSync` (similar to Phase 2's `loadStylePrefix`) or inline the prompt directly. The skeleton should show one of these patterns.

**5. [SHOULD-FIX] Stop-gate fires during review-dispatching turns, doubling API cost** (missed risk, no line reference)
When Claude is already dispatching plan reviews or code reviews (using `/opencode:review`), the Bash tool invocation to run `node buddy.mjs review ...` is an actionable tool use, causing the gate to fire a redundant review of Claude's dispatching turn. This doubles opencode API cost during review-heavy sessions. The plan doesn't acknowledge this UX cost. Consider either: (a) documenting this trade-off in D-011, or (b) adding an exclusion — if the assistant's message contains the review-dispatch marker pattern, skip the gate.

**6. [SHOULD-FIX] Fail-open trade-off should acknowledge security implication** (D-011, lines 970–972)
The plan justifies fail-open as "better to occasionally let through a bad commit than to permanently block all Stop events." This is a UX argument. But for a *safety gate*, fail-open means the gate provides no guarantee: a determined adversary (or a bug that crashes the gate) bypasses it silently. Codex chose fail-closed for this reason. The D-011 text should explicitly note this trade-off and document under what threat model fail-open is acceptable (hint: an advisory gate for development, not a security gate for CI).

### NICE-TO-HAVE

**7. [NICE-TO-HAVE] Adversarial-style `review-adversarial` role does NOT collide with session filename sanitisation** (Phase 2, lines 375)
`SAFE_COMPONENT_RE = /^[a-z0-9-]+$/` passes `review-adversarial` (hyphens are legal), so the dash is preserved. The session file pattern `${safeKey}-${safeRole}-${safeModel}.session-id` is structurally ambiguous (you can't parse key vs role from the filename without knowing the delimiter position), but since `sessionFilePath` is only used for deterministic construction (never for reverse-parsing), this is functionally fine. Confirm no reverse-parsing exists in the codebase — it doesn't. No action needed, but worth noting in the plan that the ambiguity was considered and accepted.

### Verdict

**verdict: needs-attention**

Blockers: (1) `resolveWorkspaceRoot` import from non-existent file, (2) `tool_uses` in Stop-hook stdin payload is unverified.

---

## Code Review

**Date:** 2026-05-04. **Branch:** `feature/plan-003-review-experience`.
**Reviewers (per CLAUDE.md):** `[codex]` (gpt-5.5), `[opencode-deepseek]` (deepseek/deepseek-v4-flash), `[opencode-glm]` (volcengine-plan/glm-5.1). All three ran the full diff in parallel.

### Verdicts

- `[codex]` — **Approved with suggestions** (0 MF + 2 SF + 2 NTH).
- `[opencode-deepseek]` — **Approved with suggestions** (0 MF + 2 SF + 5 NTH).
- `[opencode-glm]` — **Approved with suggestions** (0 MF + 3 SF + 3 NTH).

### Findings

#### [FIXED] Should Fix — `stopReviewGate` was not type-validated `[codex]`

**File:** `plugins/opencode/scripts/lib/config.mjs:38`

A manually edited config like `{"stopReviewGate":"false"}` (string instead of boolean) would have been truthy in the hook's `if (!cfg.value.stopReviewGate)` check, enabling the gate instead of opting out. → **Resolution:** added `VALIDATORS = { stopReviewGate: (v) => typeof v === "boolean" }` map. `loadConfig` validates user values per-key; failing values are dropped with a stderr warning and the default (false) wins. New regression tests cover the string-instead-of-boolean case + the forward-compat case (unknown keys preserved).

#### [FIXED] Should Fix — Missing non-git workspace test `[codex][opencode-glm]`

**File:** `tests/opencode/stop-gate.test.mjs`

Both reviewers caught the same gap: `checkActionable`'s `existsSync(.git)` pre-check branch (gate runs without git filter when `.git/` is missing) had no test. → **Resolution:** added test `stop-gate: non-git workspace → gate runs (treated as actionable per D-011)`. Verifies the gate proceeds to `dispatchOpencode` and the approve fixture passes through, AND the smart-skip stderr messages are absent.

#### [FIXED] Should Fix — `loadConfig` TOCTOU between `existsSync` and `readFileSync` `[opencode-glm]`

**File:** `plugins/opencode/scripts/lib/config.mjs:20`

`existsSync` followed by `readFileSync` is technically TOCTOU: file deleted in the gap → ENOENT thrown → caught and reported as ok:false (when semantically it should be ok:true with defaults). Narrow window but the fix is simpler. → **Resolution:** dropped `existsSync`; handle ENOENT inside the `readFileSync` catch (returns defaults); other I/O errors propagate as ok:false.

#### [FIXED] Should Fix — Empty-blockers UX confusing `[opencode-glm]`

**File:** `plugins/opencode/scripts/stop-review-gate-hook.mjs:185`

Trailer schema permits `{"verdict":"needs-attention","blockers":[]}`. The original message `"found ${blockers.length || "open"} concern(s)"` produced `"found open concern(s)"` — "open" reads as a synonym for "unresolved" rather than the count zero. → **Resolution:** rewrote the message to render zero-blockers explicitly: `"flagged the turn as needs-attention (no specific blockers listed)"` vs `"found N concern(s)"` for the populated case.

#### [FIXED] Should Fix — README stale plan-003 references `[opencode-deepseek]`

**File:** `plugins/opencode/README.md:148-153`

The "From v0.2.0 (tracked for plan 003 polish)" subsection still pointed to plan 003 for macOS cancel, TOCTOU, CAS, ARG_MAX. Plan 003 was renumbered to ship adversarial-review + Stop-hook gate; macOS parity is now plan 004 and `flock(2)` is plan 005. → **Resolution:** subsection retitled to "From v0.2.0 (tracked for plan 004/005 polish)" with each item retargeted appropriately.

#### [FIXED] Nice to Have — README smart-skip wording contradicted non-git behavior `[codex]`

**File:** `plugins/opencode/README.md:49-52`

The "Smart-skip behavior (no review runs in these cases)" list included "Non-git workspace... gate runs" — the bullet describes a RUN, not a skip. → **Resolution:** restructured the section into two lists: smart-skip cases (where the review doesn't run) and runs cases (where it does). Non-git workspace explicitly noted as "the gate fires on every actionable Stop with no skip heuristic — opt out via /opencode:gate off if you don't want this overhead."

#### [FIXED] Nice to Have — `/opencode:gate` silently ignored extra args `[codex][opencode-glm]`

**File:** `plugins/opencode/scripts/buddy.mjs:891`

`gate on off` succeeded silently as "on". → **Resolution:** `runGate` now rejects argv.length > 1 with exit 2 and an error message naming the unexpected args. Regression test added.

#### [WONTFIX] Nice to Have — `dispatchOpencode` "no inner timeout" claim `[opencode-deepseek]`

**File:** `plugins/opencode/scripts/stop-review-gate-hook.mjs:163`

Deepseek-v4-flash flagged the "inner dispatcher timeout (5min) fires first" comment as misleading because `dispatchOpencode` itself has no timeout parameter. → **Resolution:** `[WONTFIX]`. GLM independently verified that `invokeOpencodeRaw` (which `dispatchOpencode` calls) has `DEFAULT_TIMEOUT_MS = 5 * 60 * 1000`. The 5-minute inner timeout exists; deepseek's read missed the chain. The comment is accurate.

#### [WONTFIX] Nice to Have — Corrupted config silently consumed `[opencode-deepseek]`

**File:** `plugins/opencode/scripts/lib/config.mjs:31`

When `JSON.parse` fails, the warning goes to stderr and the loader returns DEFAULT_CONFIG. A scripting consumer that only reads stdout might miss the signal. → **Resolution:** `[WONTFIX]`. Trade-off for advisory config — fail-open on a corrupted user-edited file is the right default for `/opencode:gate status`-style read paths. The stderr warning is the canonical signal; a future plan can add `--strict` if needed.

#### [WONTFIX-NTH] Missing tests for prompt-template ENOENT fallback (adversarial + stop-gate) `[opencode-deepseek]`

**Files:** `plugins/opencode/scripts/lib/prompt.mjs:14`, `plugins/opencode/scripts/stop-review-gate-hook.mjs:113`

Both fallback paths are ENOENT-narrow and trivial (one-line `template = INLINE_*`). Adding tests would mock-delete the template files. → **Resolution:** `[WONTFIX]`. The fallback is exercised in production whenever a user runs from a partial install (pre-Phase-5 dev state). Defer; unlikely to regress.

#### [WONTFIX-NTH] Vestigial assertion in stop-gate test `[opencode-deepseek]`

**File:** `tests/opencode/stop-gate.test.mjs:126`

`assert.doesNotMatch(result.stderr, /dispatching opencode reviewers/i)` checks for a message that the dropped soft-skip would have emitted. → **Resolution:** `[WONTFIX]`. Keep as a regression guard in case soft-skip is reintroduced accidentally; the assertion documents what was dropped.

#### [WONTFIX-NTH] Stale `.tmp` cleanup `[opencode-glm]`

**File:** `plugins/opencode/scripts/lib/config.mjs:51`

A crashed write between `writeFileSync(tmp)` and `renameSync(tmp, path)` leaves a stale `.tmp.<pid>.<ts>` file. → **Resolution:** `[WONTFIX]` (matches plan-002's identical jobs.mjs deferral). Files are tiny, dir is gitignored, accumulation is bounded. Can revisit if production usage shows it as a real issue.

#### [WONTFIX-NTH] Meta-skip regex doesn't cover renamed paths `[opencode-glm]`

**File:** `plugins/opencode/scripts/stop-review-gate-hook.mjs:75`

`/^.. \.claudecode-buddy\//` doesn't match git porcelain rename format `R  old -> new`. → **Resolution:** `[WONTFIX]`. `.claudecode-buddy/` is gitignored in production, and renames within it are extremely unlikely (it's runtime state, not user code). Safe-direction edge case.

#### [WONTFIX-NTH] Non-git workspaces fire on every Stop `[opencode-deepseek]`

**File:** `plugins/opencode/scripts/stop-review-gate-hook.mjs:53-54`

Per D-011, non-git workspaces have no skip heuristic. Cost = one opencode invocation per actionable turn. → **Resolution:** `[WONTFIX]`. Documented in README + D-011 with explicit guidance: opt out via `/opencode:gate off` if not wanted. Adding a heuristic for non-git workspaces (e.g., timestamp-based "any file modified recently") is plan 005+ if it surfaces as a pain.

### Verdict

All Must Fix items: **0**. All Should Fix items resolved (`[FIXED]`); 7 Nice to Have items resolved as `[WONTFIX]` with justification. Test suite: 231 → 236 (+5 new regression tests). 233 pass / 3 e2e skipped. Branch ready to push as a PR.

---

## Follow-up plans queued

- **Plan 004 — macOS parity + stdin-as-prompt** (formerly part of plan-002 slot before renumbers).
  - macOS support for `pidIsOurSupervisor` (via `ps -o command=`).
  - macOS support for `--task-file` TOCTOU defense (via `F_GETPATH` fcntl).
  - `--task` stdin-as-prompt to bypass macOS ARG_MAX limits.
- **Plan 005 — Concurrency hardening with `flock(2)`.** Proper at-most-one-holder for `lib/jobs.mjs:updateJob` (replacing best-effort CAS) and `lib/sessions.mjs:acquireSessionLock` (replacing the v0.3.0 mkdir-EEXIST primitive that requires manual-rm recovery for stranded locks).
- **Plan 006+ — Session continuity polish.** `/opencode:sessions` list/clear, `--fork` flag, auto-prune of stale `.session-id` files.

---

## Post-execution report

**Date:** 2026-05-04
**Branch:** `feature/plan-003-review-experience`
**Author:** Claude (Opus 4.7, 1M context)

### What was implemented

All 7 phases shipped:

| Phase | Component | Key commit |
|---|---|---|
| 1 | `lib/config.mjs` (workspace plugin config CRUD) | `919f94b` |
| 2 | `--style adversarial` flag + prompt template | `e950f0b` |
| 3 | `/opencode:gate on\|off\|status` slash command | `a5a1d40` |
| 4 | `stop-review-gate-hook.mjs` (opt-in + git-state smart-skip + fail-open) | `76b0d06` |
| 5 | `hooks.json` Stop entry + `prompts/stop-review-gate.md` | `138e99d` |
| 6 | Slash command + subagent + CLAUDE.md docs | `7c71174` |
| 7 | CHANGELOG / README / D-011 / version 0.3.0 → 0.4.0 / post-execution report | this commit |

### Test counts

- Plan 002 baseline: 205 tests (200 pass + 3 e2e skipped + 2 plan-001 fixes).
- Plan 003 adds: 26 new tests (config: 10, gate-cmd: 5, --style: 3, stop-gate: 8).
- v0.4.0: **231 tests**, 228 pass, 3 e2e skipped.

### Deviations from the plan

- **Phase 1+2 test files combined into one suite** in `tests/opencode/review-cmd.test.mjs` rather than a separate file (the plan suggested either; consolidating with existing review-cmd tests was cleaner).
- **Existing `setupRepo` helper in stop-gate.test.mjs** intentionally does NOT add `.gitignore` for `.claudecode-buddy/` — most production users haven't gitignored it yet, so the meta-skip path is the realistic test scenario. A separate `gitignoreBuddyDir(dir)` helper is used by the clean-tree test where the gitignore is needed.
- **No deviations from the plan's design.** The 5 plan-review rounds + 2 round-2 design pivots locked the design; implementation followed it directly.

### Known limitations (also in CHANGELOG + README)

- Edited-then-reverted edge case: gate smart-skips when working tree is clean even if assistant claimed edits.
- Concurrent Claude Code sessions in the same workspace: dispatcher's lock-degraded-mode handles the race correctly.
- Module-load gap: narrow window mitigated by static-builtins-only static imports + immediate handler registration.
- Soft-skip on assistant-message regex was deliberately dropped during round-2 review (false-positive risk).

### Follow-up plans queued

- **Plan 004 — macOS parity + stdin-as-prompt** (formerly part of plan-002 slot before renumbers).
  - macOS support for `pidIsOurSupervisor` (via `ps -o command=`).
  - macOS support for `--task-file` TOCTOU defense (via `F_GETPATH` fcntl).
  - `--task` stdin-as-prompt to bypass macOS ARG_MAX limits.
- **Plan 005 — Concurrency hardening with `flock(2)`.** Proper at-most-one-holder for `lib/jobs.mjs:updateJob` (replacing best-effort CAS) and `lib/sessions.mjs:acquireSessionLock` (replacing the v0.3.0 mkdir-EEXIST primitive that requires manual-rm recovery for stranded locks).
- **Plan 006+ — Session continuity polish.** `/opencode:sessions` list/clear, `--fork` flag, auto-prune of stale `.session-id` files.

### User action required

Plan 003 introduces `--style adversarial` and the opt-in Stop-hook gate. To exercise from inside Claude Code:

1. Run `bash scripts/install-local.sh` (already symlinked from plan 001; no re-install needed unless new files were added — they were: `commands/gate.md`, `prompts/`, `scripts/stop-review-gate-hook.mjs`).
2. Restart Claude Code so the marketplace and plugin reload.
3. New flag: `/opencode:review --style adversarial`. New slash command: `/opencode:gate on|off|status`. New hook fires automatically when gate is ON.

The previously-pinned models for the dual-review pipeline are unchanged.
