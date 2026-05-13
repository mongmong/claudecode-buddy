# Plan 006 — Bug-audit fixes (critical-path safety)

## Background

A 4-way repo bug audit (Codex + DeepSeek-V4-Flash + GLM 5.1 + self-Opus) on commit `c7b25e2` (post-v0.5.0) surfaced **2 critical, 8 high, 10 medium, 12+ low findings + 5 test-coverage gaps**.
Multi-model audit confirmed real value — each reviewer found things the others missed.

This plan addresses the **critical-path safety subset** — items where the gap is exploitable, hits real users, or affects correctness rather than performance.
The remaining findings (H5/H6/H7/H8, all M*, all L*) defer to plan-007 (correctness polish) and plan-008 (performance + drift hazards).

Audit outputs preserved at `/tmp/cb-audit/{deepseek,glm}.{out,err}` for the duration of this plan; the consolidated triage table is in the conversation log preceding this plan's commit.

## Scope (in)

| Phase | Audit ID | Severity | Surface |
|---|---|---|---|
| 1 | H1 | high | `git diff --no-ext-diff` everywhere — closes RCE via malicious `diff.external` config |
| 2 | H2 + M1 | high + medium | fd-bound `--prompt-file` (matches existing `--task-file` defense) + apply same pattern to `scope.mjs` untracked-file read |
| 3 | C1 | critical (latent) | `.catch()` on the 3 top-level `async` dispatches in `buddy.mjs:958,962,964` |
| 4 | H4 | high | Session-start + session-end hooks adopt fail-open ESM ordering matching `stop-review-gate-hook.mjs` (static `node:*` → register `uncaughtException` → dynamic `await import()` for own modules) |
| 5 | H3 + C2 + M2 | high + critical + medium | Cancel correctness: SIGTERM handler in `supervisor.mjs` releases lock + updates job before exit; `pidIsOurSupervisor` uses `ps -o command=` on macOS (closes the documented PID-reuse gap); `session-start.mjs` orphan-detect uses the same cmdline check |

## Scope (out — deferred to future plans)

| Audit ID | Severity | Why deferred |
|---|---|---|
| H5 | high | Job-state CAS TOCTOU. Already documented as known-limitation; proper `flock(2)` ships in plan-007 (queued). Plan-006 doesn't worsen it. |
| H6 | high | Lock-handoff window between `spawn()` and `"spawn"` event. Narrow window, requires `uncaughtException` registration in parent — invasive. Plan-007. |
| H7 | high | **Pre-existing exit-0-on-failure issue continues across 33 sites.** Plan-006 inherits the status quo — users see the same broken `$?` behavior they have today, no regression introduced. Plan-007a focuses on exit-code propagation + the test matrix it requires. Per Codex round-1 [c5] — deferral is "no NEW regression but pre-existing pain continues", NOT "safe in absolute terms." |
| H8 | high | Timeout kills only direct opencode child. Process-group rework is non-trivial. Plan-007. |
| M3-M10 | medium | Quality-of-life + perf items. Plan-008 polish. |
| L1-L11 | low | Plan-008+ polish. |

## Phase 1 — `git diff --no-ext-diff` everywhere (H1)

**Goal:** add `--no-ext-diff` and `--no-textconv` to every `git diff` invocation in the plugin so untrusted-repo `diff.external` / textconv drivers cannot execute arbitrary code when `/opencode:review` builds the prompt.

**Files (revised after [d1]):**
- Modify: `plugins/opencode/scripts/lib/scope.mjs` — **4 call sites**, not 3. Per `[d1]`:
  - `scope.mjs:35` — `hasBranchDivergence()` runs `git diff --shortstat ${base}...HEAD` (auto-scope probe path; called from `resolveScope`)
  - `scope.mjs:124` — branch scope: `git diff ${base}...HEAD`
  - `scope.mjs:129-130` — working-tree scope: `git diff --cached` + `git diff`
- Modify: `plugins/opencode/scripts/buddy.mjs:diffSummary` — `git diff --stat` after foreground `run`.
- Audit: `grep -rn "diff" plugins/opencode/scripts/lib/git.mjs` for any other call sites I might be missing. The grep result drives any additional fixes.
- Test: `tests/opencode/scope.test.mjs` — 2 tests: (1) `getDiff` survives `diff.external = /bin/false`; (2) `hasBranchDivergence` (via `resolveScope`) survives the same.

**Steps (TDD):**

- [ ] Step 1: baseline — run existing scope tests, document any pre-existing test that depends on git diff behavior
  `node --test tests/opencode/scope.test.mjs 2>&1 | tail -10`
- [ ] Step 2: grep for all git-diff call sites
  `grep -rnE "runGit.*diff|execFileSync.*diff" plugins/opencode/scripts/lib/`
- [ ] Step 3: write the failing test for `getDiff` working-tree scope
  Create fixture repo, `git config diff.external /bin/false`, modify a file, call `getDiff({scope: "working-tree", base: null, cwd: fixtureDir})`.
  Assert `result.ok === true` AND the diff body contains the modification.
  Without `--no-ext-diff`, `/bin/false` exits 1 → git aborts → `result.ok === false`.
- [ ] Step 4: write the failing test for `hasBranchDivergence` auto-scope path
  Set up fixture as above; call `resolveScope({scope: "auto", base: "main", cwd: fixtureDir})`.
  Assert `result.ok === true`. Without the fix, the auto-scope probe trips on `/bin/false` and `resolveScope` errors out.
- [ ] Step 5: run both tests → RED
  Both tests should fail under current code.
- [ ] Step 6: apply the fix
  In `scope.mjs`, every `runGit(cwd, ["diff", ...])` becomes `runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", ...])`. Same for `runGit(cwd, ["diff", "--shortstat", ...])`. Same in `buddy.mjs:diffSummary` for `git diff --stat`.
- [ ] Step 7: run both new tests → GREEN
- [ ] Step 8: full suite still green
  `node --test tests/`
- [ ] Step 9: commit
  `fix(opencode): add --no-ext-diff --no-textconv to all git diff calls (closes H1 RCE)`

## Phase 2 — fd-bound `--prompt-file` + `scope.mjs` untracked (H2 + M1)

**Goal:** close the realpath→read TOCTOU window for both file-input paths.

**Helper extraction strategy (revised after \[g\] + N2):**
Do **not** force both call sites through one validation function — they need different validation logic.
Extract a minimal primitive:

```js
// lib/fd-bound.mjs (NEW)
// Open the path, return {fd, fstat, fdResolvedPath} where:
//   - fd is the open descriptor (caller MUST closeSync after use, in try/finally)
//   - fstat is the fstat result on the fd (use to check isFile / isSymbolicLink etc)
//   - fdResolvedPath is realpathSync('/proc/self/fd/<fd>') on Linux, null on macOS
export function openFdBound(path) { ... }
```

**Validation contract (resolves N2):**
- Callers ALWAYS run `isUnderAllowedDir(path)` (path-based check, current behavior on both Linux + macOS).
- On Linux: callers ADDITIONALLY validate `fdResolvedPath` against the allowed-dir base. This is the fd-bound TOCTOU defense — even if the path is swapped to a symlink between `isUnderAllowedDir(path)` and `readFileSync(fd)`, `fdResolvedPath` still points to the original inode's path under the allowed dir.
- On macOS: `fdResolvedPath` is `null`; callers skip the additional fd-bound check and rely on the path-based check alone. **macOS retains the existing symlink-swap TOCTOU known-limitation** (path resolves at `realpathSync` time, content read happens later — race window). Plan-006 does NOT close this on macOS; F_GETPATH-based defense (via native binding or `stat -f` shell-out) is queued for plan-009+.

So macOS callers see the **status-quo behavior** (path-based isUnderAllowedDir + readFileSync(fd) where fd-binding still gives inode-stability for the read but no path-stability defense). Linux callers see the **upgraded behavior** (path-based + fd-resolved-path validation).

**fd leak prevention (per GLM + self-opus non-blocker):**
Every caller wraps fd usage in `try { ... } finally { try { closeSync(fd); } catch {} }`. The existing `readTaskFileFdBound` already does this; new callers (`readPromptFileFdBound`, `readUntrackedFdBound`) follow the same shape.

Then `readTaskFileFdBound` calls `openFdBound` + does the `--task-file`-specific allowed-dir check (path-based always; fd-resolved-path additionally on Linux) + `readFileSync(fd)` — with `try/finally closeSync`.
A new `readPromptFileFdBound` is structurally identical but with `--prompt-file` in the error messages (per \[d3\]).
A new `readUntrackedFdBound` (in `scope.mjs`) calls `openFdBound` + checks `fstat.isFile()` + `readFileSync(fd)` — also with `try/finally closeSync`.

**Files:**
- Create: `plugins/opencode/scripts/lib/fd-bound.mjs` — `openFdBound(path)` primitive.
- Modify: `plugins/opencode/scripts/buddy.mjs:106-138` — refactor `readTaskFileFdBound` to call `openFdBound`. Add `readPromptFileFdBound` (label-distinct error messages).
- Modify: `parsePromptArgs` (`buddy.mjs:178-189`) — replace `readFileSync(promptFile, "utf8")` with `readPromptFileFdBound`.
- Modify: `plugins/opencode/scripts/lib/scope.mjs:80-100` — `readUntrackedAsDiff` uses `openFdBound` + `fstatSync(fd).isFile()` + `readFileSync(fd)`.
- Test: `tests/opencode/fd-bound.test.mjs` — unit test the `openFdBound` primitive directly with the symlink-swap scenario.
- Test: `tests/opencode/prompt-cmd.test.mjs` — integration test for `--prompt-file` symlink-swap.
- Test: `tests/opencode/scope.test.mjs` — integration test for untracked symlink-swap.

**Test design (revised after \[c1\]+\[c2\]+\[g1\]):**

The proof is **inode binding via fd**, not path-resolution. Concrete deterministic test:

```js
// 1. Create file A under allowed dir with content "safe-content".
// 2. Create file B somewhere else with content "dangerous-content".
// 3. openSync(A) → get fd.
// 4. Between open and read: rmSync(A); symlinkSync(B, A).
//    Now A is a symlink → B.
// 5. readFileSync(fd) returns "safe-content" (fd is bound to A's original inode).
//    readFileSync(A) (path-based) would return "dangerous-content".
// 6. realpathSync('/proc/self/fd/' + fd) returns A's path (still under allowed dir).
//    realpathSync(A) returns B's path (outside allowed dir).
```

**Distinct content** ("safe-content" vs "dangerous-content") makes the assertion unambiguous. The test does NOT need a real race — the post-open / pre-read swap happens deterministically in test-controlled sequence.

**Steps (TDD):**

- [ ] Step 1: write the `openFdBound` symlink-swap test (red)
  Symlink-swap-after-open scenario. Assert `readFileSync(fd)` returns original content; `realpathSync('/proc/self/fd/' + fd)` returns original path.
- [ ] Step 2: run → red (helper doesn't exist yet)
- [ ] Step 3: create `lib/fd-bound.mjs` with `openFdBound` (Linux-only `/proc/self/fd/` resolution; on non-Linux, `fdResolvedPath` is `null`). **Callers ALWAYS run `isUnderAllowedDir(path)` regardless of platform** — what changes by platform is only the *additional* fd-resolved-path validation: Linux callers add it on top of the path-based check; macOS callers skip only that additional fd-bound step (path-based check still runs). Per N2 resolution.
- [ ] Step 4: run → green
- [ ] Step 5: write the integration test for `--prompt-file` (red — buggy code currently uses path-based `readFileSync`)
  Same symlink-swap scenario but driven through `runCompanion(["prompt", "--prompt-file", ...])`. Original content == "safe-content" should appear in opencode args (via the `mock-opencode-record-args.mjs` fixture).
- [ ] Step 6: refactor `readTaskFileFdBound` to call `openFdBound`; add `readPromptFileFdBound`; rewire `parsePromptArgs`
- [ ] Step 7: run → green
- [ ] Step 8: write the integration test for `scope.mjs` untracked symlink-swap (red)
  Untracked file, swap-to-symlink, assert `getDiff` does not inline the symlink target's content. Original-content vs symlink-target-content distinction.
- [ ] Step 9: rewrite `readUntrackedAsDiff` to use `openFdBound` + `fstatSync(fd).isFile()` + `readFileSync(fd)`
- [ ] Step 10: run → green
- [ ] Step 11: full suite green
- [ ] Step 12: commit
  `fix(opencode): fd-bound prompt-file + scope.mjs untracked reads (closes H2 + M1)`

**macOS scope-out:** `openFdBound` and downstream callers preserve the existing Linux-only constraint (uses `/proc/self/fd/`).
On macOS, the path-based check still runs; the fd-bound `realpath` step is skipped (caller falls back to the previous behavior).
The existing `--task-file` macOS limitation note already covers this; Phase 2 documents that the constraint extends to `--prompt-file` and untracked-file reads.
**Test gating:** the new tests use `process.platform === "linux"` guards (skip on darwin) — same pattern as existing `--task-file` tests.

## Phase 3 — `.catch()` on top-level async dispatches (C1)

**Goal:** eliminate the unhandled-rejection footgun in `buddy.mjs`'s top-level dispatch.

**Files (revised after \[g\] line-number drift):**
- Modify: `plugins/opencode/scripts/buddy.mjs:958,961,964` (3 dispatches; line 962 in plan-006 round-1 was off by 1 — actual lines are 958, 961, 964 per `git grep -n 'runReview\\|runRun\\|runPrompt'`).
- Modify: `runReview`, `runRun`, `runPrompt` — add a top-of-function check for the test-only env var (per [c3] resolution):
  ```js
  if (process.env.OPENCODE_BUDDY_TEST_THROW === "<funcName>") {
    throw new Error(`OPENCODE_BUDDY_TEST_THROW=<funcName> simulated failure`);
  }
  ```
  This is the **injection seam** that lets the test verify the `.catch` handler engages.
- Test: `tests/opencode/dispatch.test.mjs` (NEW) — set `OPENCODE_BUDDY_TEST_THROW=runReview`, spawn `buddy.mjs review ...`, assert exit code 2 + stderr matches "unhandled error: ... simulated failure". Same for `runRun` and `runPrompt`.

**Steps (TDD):**

- [ ] Step 1: write the unhandled-rejection test for `runReview` (red)
  `runCompanion(["review", "--scope", "working-tree"], {OPENCODE_BUDDY_TEST_THROW: "runReview", ...})` → assert exit code 2 + stderr contains "unhandled error".
- [ ] Step 2: run → red (env var doesn't exist; even if it did, no `.catch` would catch the throw → Node exits with code 1 from unhandled rejection)
- [ ] Step 3: add `OPENCODE_BUDDY_TEST_THROW` check at top of `runReview`, `runRun`, `runPrompt`
- [ ] Step 4: add the `.catch()` wrappers to the 3 top-level dispatches at lines 958/961/964:
  ```js
  if (subcommand === "review") {
    runReview(rest).catch((err) => {
      process.stderr.write(`unhandled error: ${err.stack ?? err.message ?? err}\n`);
      process.exit(2);
    });
  } else if (subcommand === "prompt") {
    runPrompt(rest).catch((err) => { ... process.exit(2); });
  } else if (subcommand === "run") {
    runRun(rest).catch((err) => { ... process.exit(2); });
  }
  ```
- [ ] Step 5: run → green
- [ ] Step 6: write 2 more tests for `runRun` + `runPrompt` (same pattern); confirm green
- [ ] Step 7: full suite green
- [ ] Step 8: commit
  `fix(opencode): .catch() on top-level async dispatches + test seam (closes C1)`

**Test seam in production code is acceptable** because:
- The check is at the very top of each runner; cost is one env-var lookup per invocation.
- The throw only fires when explicitly set; production users never hit it.
- It's the simplest viable seam for testing a defensive measure that has no natural failure mode in the current code.
- Documented in the README's "Environment overrides" table as test-only.

## Phase 4 — Session hooks fail open (H4)

**Goal:** `session-start.mjs` + `session-end.mjs` adopt the fail-open ESM ordering already proven in `stop-review-gate-hook.mjs`.

**Scope clarification (revised after \[g\]):**
The fail-open pattern applies to **ESM-load failures only** — i.e., the dynamic `await import("./jobs.mjs")` failing to resolve / parse. It does **not** apply to runtime errors:
- `session-end.mjs:40` `process.exit(1)` on `updateJob` runtime error stays — that's intentional and signals real cleanup failure.
- The fail-open `uncaughtException` handler catches errors *before* the body executes (module-load + initial registration); after the dynamic import resolves, normal error handling takes over.

This matches `stop-review-gate-hook.mjs`'s own behavior — it fails open on module-load + has explicit `process.exit(0)` paths after the body runs.

**Files:**
- Modify: `plugins/opencode/hooks/session-start.mjs` — replace static `import { listJobs }` with:
  1. Static `node:*` imports only (`fs`, `path`, etc.)
  2. Register `process.on("uncaughtException", () => process.exit(0))` + `process.on("unhandledRejection", () => process.exit(0))` (fail-open).
  3. Dynamic `await import("../scripts/lib/jobs.mjs")` for own modules.
- Modify: `plugins/opencode/hooks/session-end.mjs` — same pattern.
- Add: `OPENCODE_BUDDY_TEST_THROW=hookLoad` test seam — when set, the dynamic import block throws unconditionally (per [c3] resolution).
- Test: `tests/opencode/hooks.test.mjs` — set `OPENCODE_BUDDY_TEST_THROW=hookLoad`, spawn the hook, assert exit code 0 (fail-open).

**Steps (TDD):**

- [ ] Step 1: write the fail-open test for session-start (red)
  Spawn `node hooks/session-start.mjs` with `OPENCODE_BUDDY_TEST_THROW=hookLoad`. Assert exit code 0.
- [ ] Step 2: run → red (current static import would cause a syntax / module-resolution error if we forced one; without the env-var seam, no failure path exists to test).
- [ ] Step 3: rewrite session-start.mjs to match the stop-review-gate ESM ordering. Add the `OPENCODE_BUDDY_TEST_THROW=hookLoad` check at the top of the dynamic-import block (forces a throw when set).
- [ ] Step 4: run → green
- [ ] Step 5: write the fail-open test for session-end (red → fix → green)
- [ ] Step 6: full suite green
- [ ] Step 7: commit
  `fix(opencode): session hooks adopt fail-open ESM ordering (closes H4)`

**Note for Phase 5:** session-start.mjs's dynamic-import block also needs `pidIsOurSupervisor` (Phase 5c). Phase 5c's import statement must go inside the dynamic block (not as a static import) — see Phase 5c step list.

## Phase 5 — Cancel correctness (H3 + C2 + M2)

**Goal:** `/opencode:cancel` no longer strands the session lock, no longer fires SIGTERM at unrelated PIDs on macOS, and orphan detection uses the same cmdline-based identity check.

### 5a. SIGTERM handler in supervisor.mjs (H3)

**Defensive structure (revised after \[c6\]+\[g2\] + round-2 N1):**

**Resolves N1 (Codex round-2):** The original revision placed SIGTERM handlers AFTER dynamic imports and claimed `uncaughtException` covered the pre-import window. **This was wrong — SIGTERM is a signal, not a thrown exception; `uncaughtException` does not fire on signals.** The 5-50ms import-resolution window had no handler, so SIGTERM during that window would have killed the supervisor without releasing the lock OR updating the job record. (DeepSeek-Pro round-2 argued the window is "negligible because no lock is held," but that's also incorrect: the parent acquires the lock BEFORE spawn and ownership transfers around the `"spawn"` event, so during the supervisor's import window the lock IS held by whichever side hasn't completed the handoff.)

**Two-layer handler design (resolves N1):**

1. **Inline early handler** registered immediately after `process.title` / `inlineLockDir`/`inlineJobPath` definitions, BEFORE dynamic imports. Uses the same inline path-derivation functions the existing `uncaughtException` handler uses. Module-scope `let child = null` so the handler can `child.kill(signal)` if it's been spawned. Catches SIGTERM/SIGINT during the 5-50ms import window.

2. **Same handler reused after dynamic imports** — once `releaseLock` / `updateJob` from real modules are available, the handler's body uses them; before, it falls back to inline `rmSync` + inline atomic JSON write. A boolean flag (e.g., `dynamicImportsReady = false → true after await`) gates which branch runs.

```js
// At top of supervisor.mjs, right after argv validation + process.title:
let child = null;                  // module-scope; assigned after dynamic imports + spawn
let dynamicImportsReady = false;   // flipped to true after the await blocks below
let signalHandled = false;         // prevents double-fire if SIGTERM + SIGINT both arrive

function handleSignal(sig) {
  if (signalHandled) return;
  signalHandled = true;
  try {
    if (dynamicImportsReady) {
      // Real-module path: identical to the post-import handler body.
      try { releaseLock(); } catch {}
      try {
        updateJob(projectDir, jobId, {
          status: "cancelled",
          finished_at: new Date().toISOString(),
          exit_code: sig === "SIGINT" ? 130 : 143,
        }, { expectedStatus: ["running", "session-ended"] });
      } catch {}
    } else {
      // Inline-fallback path: dynamic imports haven't resolved yet.
      try {
        if (!degraded) rmSync(inlineLockDir(), { recursive: true, force: true });
      } catch {}
      try {
        const jobPath = inlineJobPath();
        const record = JSON.parse(readFileSync(jobPath, "utf8"));
        record.status = "cancelled";
        record.exit_code = sig === "SIGINT" ? 130 : 143;
        record.finished_at = new Date().toISOString();
        const tmp = `${jobPath}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
        renameSync(tmp, jobPath);
      } catch {}
    }
  } finally {
    try { if (child && !child.killed) child.kill(sig); } catch {}
    process.exit(sig === "SIGINT" ? 130 : 143);
  }
}
process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT",  () => handleSignal("SIGINT"));

// ... existing uncaughtException handler ...

// Dynamic imports:
const { updateJob, jobsDir } = await import("./jobs.mjs");
const { saveSessionId, deleteSessionId, sessionLockPath } = await import("./sessions.mjs");
const { captureSessionIdFromStderr, captureLatestSessionForCwd } = await import("./session-capture.mjs");
dynamicImportsReady = true;
```

The pre-import inline branch has identical semantics to the post-import branch — just uses inline path-derivation + inline atomic write instead of imported helpers. The post-import branch uses the real helpers. The boolean flag ensures the right branch runs at the right time.

**Test expectation update (round-3):** add a test that triggers SIGTERM in the pre-import window via a fixture supervisor with a deliberately-slowed dynamic import. Use `OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS=200` env-var seam to force a 200ms delay before dynamic imports complete; spawn supervisor, send SIGTERM within 200ms, assert lock dir is gone + job marked cancelled. Counter-test: same but without the slow-import seam, asserting the post-import branch ran.

### 5b. macOS cmdline check (C2)

**Injectable platform + cmdlineReader (revised after \[c4\]+\[g3\]):**
The existing `pidIsOurSupervisor(pid, jobId)` hard-codes `process.platform` and `/proc/<pid>/cmdline`. Refactor into:

```js
// lib/pid-identity.mjs (NEW)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function pidIsOurSupervisor(pid, jobId, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const cmdlineReader = opts.cmdlineReader ?? defaultCmdlineReader(platform);
  let cmdline;
  try { cmdline = cmdlineReader(pid); } catch { return false; }
  return cmdline.includes(`buddy-supervisor:${jobId}`);
}

function defaultCmdlineReader(platform) {
  if (platform === "linux") {
    return (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8");
  }
  if (platform === "darwin") {
    return (pid) => execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return () => { throw new Error(`unsupported platform: ${platform}`); };
}
```

**Test verification on Linux CI (resolves \[c4\]+\[g3\]):**
Tests inject `{platform: "darwin", cmdlineReader: (pid) => "node /path/buddy-supervisor:job_xxx --etc"}` and verify the macOS branch returns `true` for the matching job. Inject a non-matching cmdline (`"node /unrelated/process"`) and verify `false`. This exercises the `platform === "darwin"` branch's logic on Linux CI without needing a real macOS host. Add a separate `process.platform === "darwin"` integration test that runs only on macOS for end-to-end validation (skipped via `t.skip()` on Linux).

### 5c. Orphan detection cmdline check (M2)

**Sequencing with Phase 4 (revised after \[d2\]+\[g\] resolution):**
Phase 4 rewrites `session-start.mjs` with the fail-open ESM ordering (static `node:*` only → register handler → dynamic imports). Phase 5c adds `pidIsOurSupervisor` as a **dynamic import** inside the post-handler block:

```js
// session-start.mjs — POST-PHASE-4 + PHASE-5c shape:
// (static node:* imports above — fail-open handlers registered)
const { listJobs } = await import("../scripts/lib/jobs.mjs");
const { pidIsOurSupervisor } = await import("../scripts/lib/pid-identity.mjs");

// then in orphan detection:
const orphans = list.value.filter((j) => {
  if (j.status === "session-ended") return true;
  if (j.status === "running" && !pidIsOurSupervisor(j.pid, j.id)) return true;
  return false;
});
```

The dynamic import preserves fail-open semantics (per [d2]'s blocker). GLM's contradiction (claiming static is fine) is rejected on the conservative side: even if `pid-identity.mjs` only imports `node:*`, it's still our code that could fail to load (syntax error, future refactor).

**Files:**
- Create: `plugins/opencode/scripts/lib/pid-identity.mjs` — exported `pidIsOurSupervisor(pid, jobId, opts)` with injectable platform + cmdlineReader.
- Modify: `plugins/opencode/scripts/lib/supervisor.mjs` — register SIGTERM + SIGINT handlers **at the top of the module** (right after `process.title` / inline-function definitions, BEFORE dynamic imports) per N1 round-3 resolution. The handler's body branches on `dynamicImportsReady` — uses inline path-derivation + inline atomic JSON write before imports complete, switches to real `releaseLock`/`updateJob` after. See "Two-layer handler design" above.
- Modify: `plugins/opencode/scripts/buddy.mjs:363-381` — replace inline `pidIsOurSupervisor` with `import { pidIsOurSupervisor } from "./lib/pid-identity.mjs"` (static — buddy.mjs is the main runner, doesn't have fail-open constraints).
- Modify: `plugins/opencode/hooks/session-start.mjs` — dynamic import + use in orphan detection.
- Test: `tests/opencode/pid-identity.test.mjs` (NEW) — unit-test the helper with both injected platforms (linux/darwin) and verify each branch's logic. Linux-CI-friendly via injection.
- Test: `tests/opencode/run-cmd.test.mjs` — extend an existing cancel test to assert the session lock dir does NOT exist after cancel. **Lock-path fabrication (per [d3] non-blocker):** use the same `(key, role, model)` derivation logic via `currentSessionKey({cwd: dir, override: null})` then `sessionLockPath(projectDir, key, "run", "vendor/x")`.
- Test: `tests/opencode/cancel-cmd.test.mjs` — add a PID-reuse simulation test using `pidIsOurSupervisor` injected to return `false`; assert cancel reports "not our supervisor" rather than sending SIGTERM. (Test exercises the buddy.mjs `runCancel` path with a mock helper, dependency-inject pattern.)
- Test: `tests/opencode/hooks.test.mjs` — extend orphan-detection test with PID-reuse simulation.

**Steps (TDD):**

- [ ] Step 1: write the `pid-identity.mjs` unit tests (red)
  - linux branch: cmdlineReader returns matching cmdline → `true`; non-matching → `false`; reader throws → `false`.
  - darwin branch: same with macOS-formatted ps output; verify `execFileSync("ps", ...)` is called when no `cmdlineReader` injected (use spy / cwd-mock).
- [ ] Step 2: run → red (helper doesn't exist)
- [ ] Step 3: create `lib/pid-identity.mjs` with the structure above
- [ ] Step 4: run → green; full suite green
- [ ] Step 5: write the SIGTERM-releases-lock test (red)
  Spawn a background `run` job; cancel it; assert: (a) job status flips to "cancelled" or "session-ended"; (b) `existsSync(sessionLockPath(...))` is `false`. Without the SIGTERM handler, the lock dir persists.
- [ ] Step 6: run → red (current cancel strands the lock).
- [ ] Step 7: add SIGTERM + SIGINT handlers to `supervisor.mjs` (defensive structure above).
- [ ] Step 8: run → green.
- [ ] Step 9: rewire `runCancel` to use the extracted `pidIsOurSupervisor`. Drop the inline implementation.
- [ ] Step 10: rewire `session-start.mjs` to dynamic-import + use `pidIsOurSupervisor` (the Phase-4-modified file).
- [ ] Step 11: write the PID-reuse-simulation test for cancel (red — the test injects a mock that returns `false`; current cancel still SIGTERMs). Note: the dependency-injection requires either passing `opts.cmdlineReader` through to runCancel from a test-only env var OR mocking `pidIsOurSupervisor` via test-fixture import-substitution. Choose the env-var approach for symmetry with `OPENCODE_BUDDY_TEST_THROW`: e.g., `OPENCODE_BUDDY_TEST_PID_NEVER_OURS=1` → cancel sees `pidIsOurSupervisor` returns false → reports "not our supervisor".
- [ ] Step 12: implement the test seam in `runCancel`.
- [ ] Step 13: run → green.
- [ ] Step 14: full suite green.
- [ ] Step 15: commit
  `fix(opencode): cancel correctness — SIGTERM releases lock, injectable cmdline check, dynamic pid-identity import in session-start (closes H3 + C2 + M2)`

**PID-title race window (documented per \[g\] non-blocker):**
Between supervisor `spawn()` and `process.title = "buddy-supervisor:<jobId>"` (supervisor.mjs:36), there's a ~10-50ms window where the OS sees the process as `node` not `buddy-supervisor:<jobId>`. A cancel dispatched in this window correctly sees PID alive but `pidIsOurSupervisor` returns `false` → cancel reports "not our supervisor" → user must retry. **Strictly better than the prior macOS behavior** (SIGTERM any live PID); document in the README's "Known limitations" + the `/opencode:cancel` doc with retry guidance.

## Phase 6 — Documentation + version bump + ship prep

**Goal:** v0.5.1 patch release with all phase-1-through-5 fixes.

**Files:**
- Modify: `plugins/opencode/.claude-plugin/plugin.json` — version `0.5.0` → `0.5.1`.
- Modify: `.claude-plugin/marketplace.json` — same.
- Modify: `plugins/opencode/CHANGELOG.md` — new v0.5.1 entry summarizing the 6 audit findings closed (H1, H2, M1, C1, H4, H3, C2, M2) + reference to plan-006.
- Modify: `plugins/opencode/README.md` "Requirements" + "Environment overrides" tables — add `OPENCODE_BUDDY_TEST_THROW` (test-only) + `OPENCODE_BUDDY_TEST_PID_NEVER_OURS` (test-only).
- Modify: `plugins/opencode/README.md` "Known limitations" section — mark H1/H2/H3/C2 as **CLOSED in v0.5.1**; mark H5/H6/H7/H8 as queued for plan-007; add the PID-title race window note for `/opencode:cancel`.
- Modify: `docs/plans/006-bug-audit-fixes.md` — fill in the "Post-execution report" table with all phase commits.
- Modify: `docs/architecture/decisions.md` — if any new architectural decision came out of the implementation (e.g., the test-only env-var seam pattern as a workspace convention), record it as D-013+. Likely yes for the test seam.

**Steps:**

- [ ] Step 1: run full test suite, confirm green
- [ ] Step 2: bump versions in plugin.json + marketplace.json (one commit, atomic)
- [ ] Step 3: write CHANGELOG v0.5.1 entry
- [ ] Step 4: update README known-limitations + env-var table
- [ ] Step 5: fill in plan-006 post-execution report
- [ ] Step 6: add `D-013` (test-only env-var seam convention) to decisions.md if warranted
- [ ] Step 7: commit
  `chore(opencode): v0.5.1 release — bug-audit fixes (closes H1+H2+M1+C1+H4+H3+C2+M2)`
- [ ] Step 8: 4-way code review per workspace policy

## Test count expectations (revised)

Plan-006 adds approximately **12-15 new tests** across 5 phases (revised after [s7] non-blocker):

| Phase | Tests | Notes |
|---|---|---|
| 1 | 2 | `getDiff` survives `diff.external = /bin/false`; `hasBranchDivergence` survives the same (auto-scope path) |
| 2 | 3 | `openFdBound` symlink-swap unit; `--prompt-file` integration; `scope.mjs` untracked-file integration |
| 3 | 3 | `runReview` unhandled-rejection; `runRun` same; `runPrompt` same |
| 4 | 2 | session-start fail-open on hookLoad throw; session-end same |
| 5 | 4-5 | `pid-identity` linux + darwin unit tests; SIGTERM releases lock (cancel test extension); PID-reuse simulation in cancel; PID-reuse simulation in orphan-detect |

- Baseline: 257 (254 pass + 3 e2e skipped).
- Expected after plan-006: ~272 (269 pass + 3 e2e skipped).

## Documentation updates

(Now part of Phase 6 above.)

## Plan Review (4-way)

### Round 1 (HEAD `eb0ef03`) — 3-of-4 ⚠️ needs-attention, 1 ⚠️ needs-attention

| # | Reviewer | Verdict | Output |
|---|---|---|---|
| 1 | Self-review (Opus 4.7) | ⚠️ needs-attention | inline below |
| 2 | Codex via `codex:codex-rescue` subagent | ⚠️ needs-attention | (in conversation log) |
| 3 | DeepSeek V4 Pro via bash | ⚠️ needs-attention | `/tmp/cb-plan006/deepseek-pro.out` |
| 4 | GLM 5.1 via bash | ⚠️ needs-attention | `/tmp/cb-plan006/glm.out` |

**\[self-opus\] — 5 items (all minor):**
- [s1] Phase 1 doesn't establish a baseline for existing scope tests. `--no-ext-diff` could in theory affect any test that depends on git's external-diff behavior; should run baseline first.
- [s2] Phase 1 misses a `hasBranchDivergence` test (DeepSeek-Pro caught the call site but I missed the test pairing).
- [s3] Phase 5 doesn't enumerate the existing `tests/opencode/cancel-cmd.test.mjs` + `tests/opencode/run-cmd.test.mjs` tests that need updating after the `pidIsOurSupervisor` extraction.
- [s4] No explicit version-bump or CHANGELOG step; "Documentation updates" mentioned at bottom but not bound to a phase.
- [s5] Phase 2 helper extraction: existing `readTaskFileFdBound` is exported from `buddy.mjs` (private) but referenced in tests indirectly via `runCompanion`. Renaming is safe but should verify no direct import.

**\[codex\] — 6 \[OPEN\]:**
- [c1] Phase 2 prompt-file test won't fail as written — `realpathSync` resolves the symlink before `readFileSync`, so the test passes under both buggy + fixed code.
- [c2] Phase 2 scope.mjs substitute test is invalid — an open fd sees LIVE file contents on `writeFileSync`, not snapshot. Wrong proxy for symlink TOCTOU.
- [c3] Phase 3 + Phase 4 assume monkey-patch seams that don't exist (`buddy.mjs` is a spawned CLI script).
- [c4] Phase 5 macOS `ps` test has no Linux CI verification (no `OPENCODE_BUDDY_FORCE_PLATFORM` env var exists).
- [c5] H7 deferral framing — needs to qualify "safe" as "no NEW regression but pre-existing pain continues."
- [c6] SIGTERM handler should defensively wrap both `releaseLock` AND `updateJob` (mirror existing `uncaughtException`).

**\[opencode:deepseek-v4-pro\] — 2 \[OPEN\] + non-blocker guidance:**
- [d1] **Phase 1 misses `scope.mjs:35` `hasBranchDivergence` git-diff call site** (auto-scope probe path). Same RCE vector. Must add to fix list.
- [d2] **Phase 4+5 session-start.mjs sequencing** — Phase 4 rewrites the file with fail-open ESM ordering (dynamic imports); Phase 5c adds `pidIsOurSupervisor` calls. Phase 5c's import must be **dynamic** (not static) per the fail-open pattern.
- Non-blocker: helper needs error-message label parameter (`readTaskFileFdBound` says `--task-file` in errors).
- Non-blocker: Phase 5a test needs explicit session-key/role/model fabrication.
- Non-blocker: Phase 2 test description should clarify timing (post-open, pre-read swap).
- Non-blocker: Phase 5 SIGTERM handler placement after dynamic imports preferred.

**\[opencode:glm-5.1\] — 3 \[OPEN\] + non-blocker observations:**
- [g1] Phase 2 tests are weak proxies for the actual symlink TOCTOU. Need: open file A ("safe"), swap to symlink → file B ("dangerous"), `readFileSync(fd)` returns "safe". Same conclusion as [c1]+[c2] but more concrete test design.
- [g2] Phase 5 SIGTERM handler: try/catch wrap with `process.exit(143)` in `finally` (subset of [c6]).
- [g3] Phase 5 macOS `ps` Linux CI verification: commit to mock strategy concretely (subset of [c4] but more specific).
- Non-blocker: GLM contradicts [d2] on import pattern — claims `pid-identity.mjs` could be static if it has only `node:*` deps. Resolution below.
- Non-blocker: Phase 3 line numbers slightly off (`958,961,964` not `958,962,964`).
- Non-blocker: Phase 4 fail-open scope note (ESM-load only, not runtime errors).
- Non-blocker: Phase 5 PID-title window race (~10-50ms between spawn and `process.title=`); document retry expectation.
- Non-blocker: Phase 2 conflates two patterns; recommend minimal `openFdBound(path)` primitive + caller-specific validation.

### Consolidated \[OPEN\] blockers to address in revision

| # | Source(s) | Resolution sketch |
|---|---|---|
| B1 | [d1] | Add `scope.mjs:35` (`hasBranchDivergence`) to Phase 1's fix list; pair with a `runGit(["diff", "--shortstat", ...])` call-site audit to find any other diff-shortstat sites |
| B2 | [c1]+[c2]+[g1] | **Phase 2 test redesign:** open path → swap to symlink → assert `readFileSync(fd)` returns original content (not symlink target). Use distinct content for original vs symlink-target so the assert is unambiguous. |
| B3 | [c3] | Add test-only env-var throw seams: `OPENCODE_BUDDY_TEST_THROW=runReview\|runRun\|runPrompt\|hookLoad`. Each runner / hook checks at top and throws if matched. Tests set the env, assert exit 2 + stderr message. |
| B4 | [c4]+[g3] | Refactor `pidIsOurSupervisor(pid, jobId, opts)` to accept injectable `platform` AND `cmdlineReader` (defaults: `process.platform`, native `/proc` or `ps -o command=`). Tests inject `{platform: "darwin", cmdlineReader: () => "ps-formatted-output"}` and verify the macOS branch. |
| B5 | [c5] | H7 deferral framing — replace "safe to defer" with "deferred — pre-existing exit-0-on-failure pain continues across 33 sites; plan-006 doesn't worsen it. Plan-007a focuses on exit-code propagation." |
| B6 | [c6]+[g2] | SIGTERM handler: wrap each cleanup step in try/catch; `process.exit(143)` in `finally` block; mirror existing `uncaughtException` defensive structure. |
| B7 | [d2] | Phase 5c explicit step: import `pidIsOurSupervisor` via **dynamic** `await import("../scripts/lib/pid-identity.mjs")` AFTER the `uncaughtException` handler is registered. Resolves the [d2] vs [g] disagreement on the conservative side. |

### Non-blocker improvements (will fold into the revision)

- Phase 2 helper: extract `openFdBound(path)` minimal primitive with optional `requireUnderDir` + label parameters; do NOT force both call sites through one validation function.
- Phase 1 baseline test: run existing `scope.test.mjs` first; document any pre-existing tests that need `--no-ext-diff` accommodation.
- Phase 1: pair `hasBranchDivergence` fix with a test.
- Phase 3 line-number drift: cite `958,961,964` not `958,962,964`.
- Phase 4 fail-open scope: explicitly note ESM-load failures only, not runtime errors. `session-end.mjs:40` `process.exit(1)` on runtime error is intentional and stays.
- Phase 5 PID-title window: add to "Known limitations" + the `/opencode:cancel` doc; user-visible retry expectation.
- Phase 5a test: explicitly fabricate session-key/role/model for the lock-path verification.
- Add Phase 6: version bump (0.5.0 → 0.5.1), CHANGELOG entry, README "Known limitations" updates, plan-006 post-execution report fill-in.
- Update test count expectations: 8 → ~12-15 tests across the 5 phases (red-green-refactor + edge cases per phase).

### Round 2 (HEAD `6585a0e`)

| # | Reviewer | Verdict | Output |
|---|---|---|---|
| 1 | Self-Opus 4.7 | ⚠️ needs-attention | inline below |
| 2 | Codex | ⚠️ needs-attention | (in conversation log) |
| 3 | DeepSeek V4 Pro | ✅ approve | `/tmp/cb-plan006/deepseek-pro-r2.out` |
| 4 | GLM 5.1 | ✅ approve | `/tmp/cb-plan006/glm-r2.out` |

**\[self-opus r2\]:** All 6 round-1 items confirmed RESOLVED. Two NEW blockers (matching Codex):
- [s-r2-1] Phase 2 `openFdBound` "non-Linux callers must skip allowed-dir check" contradicts scope-out's "path-based check still runs" — same as Codex N2.
- [s-r2-2] Phase 5a SIGTERM handler placement after dynamic imports leaves a 5-50ms unprotected window; my plan claimed `uncaughtException` covers it, but **SIGTERM is a signal, not an exception** — same as Codex N1.
- [s-r2-3] Non-blocker: `readPromptFileFdBound` and similar callers risk fd leak on validation-failure path (open → validate fails → return without closeSync). Need `try/finally { closeSync(fd) }` in each caller — GLM also flagged.

**\[codex r2\]:** All 6 round-1 items `[RESOLVED]`. Two NEW blockers:
- [c-r2-1 = N1] Phase 5a SIGTERM pre-import window unprotected. SIGTERM is a signal, not a thrown exception; `uncaughtException` doesn't fire on SIGTERM. The 5-50ms import-resolution window has no handler.
- [c-r2-2 = N2] Phase 2 `openFdBound` allowed-dir contradiction on macOS — same as [s-r2-1].

**\[opencode:glm-5.1 r2\]:** ✅ **approve.** All 3 round-1 items `[RESOLVED]`. No new blockers, but one minor implementation note: `readPromptFileFdBound` callers should `try/finally { closeSync(fd) }` to prevent fd leak on validation-failure path. Note: GLM accepted the plan's "uncaughtException covers SIGTERM pre-import" rationale, which Codex correctly identified as incorrect — Codex's N1 stands.

**\[opencode:deepseek-v4-pro r2\]:** ✅ **approve.** All 7 round-1 blockers `[RESOLVED]` with sound designs; no new blockers. Note: DeepSeek-Pro's argument that the SIGTERM pre-import window is "negligible because no lock has been acquired yet" is **incorrect** — the parent acquires the lock BEFORE spawn and ownership transfers around the `"spawn"` event, so during the supervisor's 5-50ms import window the lock IS held (by either parent or supervisor depending on timing). Codex's N1 stands; the round-3 revision adds the early inline SIGTERM handler.

### Consolidated round-2 \[OPEN\] blockers

| # | Source(s) | Resolution sketch |
|---|---|---|
| N1 | Codex, self-opus (GLM missed) | Phase 5a — register **inline SIGTERM/SIGINT handlers at the top of supervisor.mjs**, BEFORE dynamic imports. Use the same inline functions (`inlineLockDir`, `inlineJobPath`) the existing `uncaughtException` handler uses. Module-scope `let child = null` so the handler can `child.kill(signal)` if it's been spawned. Eliminates the 5-50ms pre-import window. |
| N2 | Codex, self-opus | Phase 2 — clarify `openFdBound` semantics: returns `{fd, fstat, fdResolvedPath}` where `fdResolvedPath` is `realpathSync('/proc/self/fd/<fd>')` on Linux, `null` elsewhere. **Callers always run `isUnderAllowedDir(path)` (path-based)**; additionally on Linux, validate `fdResolvedPath` against allowed dir for fd-bound TOCTOU defense. macOS retains the existing path-based-only behavior + the prior symlink-swap TOCTOU known-limitation (plan-006 does NOT close it on macOS; F_GETPATH-based defense queued for plan-009+). |
| Non-blocker (GLM, self-opus) | — | All `openFdBound` callers wrap fd usage in `try { ... } finally { closeSync(fd) }` to prevent fd leak on validation-failure path. |

### Round 3 (HEAD `961681d`)

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-Opus 4.7 | ✅ approve (N1+N2 fixes sound) |
| 2 | Codex | ⚠️ needs-attention — N1 [RESOLVED]; N2 [STILL OPEN] due to stale prose at Step 3 line 133 + Phase 5 file-bullet line 362 contradicting the round-3 fix |
| 3 | DeepSeek V4 Pro | (already approved at round-2; not re-dispatched) |
| 4 | GLM 5.1 | (already approved at round-2; not re-dispatched) |

**\[codex r3\]:** N1 [RESOLVED] — two-layer handler design is sound, no race at the `dynamicImportsReady` flag boundary (Node single-threaded event loop). N2 [STILL OPEN] — Step 3 of openFdBound description (line 133) still said "callers must skip the allowed-dir check" which contradicts the fix; Phase 5 file-bullet (line 362) still said "AFTER dynamic imports" which contradicts the N1 fix. Both are stale-prose leftovers from prior revisions; corrected in this commit.

### Round 4 (HEAD `dd8804e`) — ✅ ALL FOUR APPROVE

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-Opus 4.7 | ✅ approve |
| 2 | Codex | ✅ approve — "both stale-prose items corrected. No remaining ambiguities or contradictions." |
| 3 | DeepSeek V4 Pro | ✅ approve (carried from round-2) |
| 4 | GLM 5.1 | ✅ approve (carried from round-2) |

**Plan-006 cleared for implementation.** Per CLAUDE.md, all four concur — implementation proceeds on this branch starting with Phase 1.

## Code Review (4-way)

### Round 1 (HEAD `5b0f34b`)

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-Opus 4.7 | ✅ approve (no blockers; 2 minor confirmations) |
| 2 | Codex via `codex:codex-rescue` subagent | ✅ approve (no blockers; sandbox couldn't run tests independently) |
| 3 | DeepSeek V4 Flash via bash | ⚠️ needs-attention — 2 `[OPEN]` blockers (saved the merge!) |
| 4 | GLM 5.1 via bash | ✅ approve (no blockers; verified all 5 focus areas) |

**\[self-opus\]:** Confirmed via grep that `releaseLock` is a function declaration (hoisted, so the SIGTERM handler at line 85 can call it though defined at 180). Single-threaded Node event loop makes `dynamicImportsReady` boundary race-free. All 3 test seams use the `OPENCODE_BUDDY_TEST_` prefix convention consistently. ✅

**\[codex\]:** All 5 focus areas (correctness, assumptions, consistency, test coverage, doc drift) clean. Confirmed: two-layer SIGTERM safe; O_NOFOLLOW maps to `O_RDONLY | O_NOFOLLOW` correctly; test seams are exact-match-only; all openFdBound callers close in finally; pid-identity fails closed on darwin ps errors; supervisor module-scope state initialized correctly across all paths including spawn() failure. ✅

**\[opencode:glm-5.1\]:** Detailed analysis of the two-layer SIGTERM handler (no race at flag boundary; signalHandled prevents re-entry); O_NOFOLLOW POSIX semantics identical Linux+macOS; test seams namespaced with `OPENCODE_BUDDY_TEST_` prefix; `.catch` stderr labels don't collide with existing test parsing; all 3 fd callers wrap in try/finally closeSync; pid-identity execFileSync throw → false (safe deny); supervisor spawn-failure path correctly leaves `child === null` so signal handler's `if (child && !child.killed)` short-circuits. ✅

**\[opencode:deepseek-v4-flash\]:** Caught **2 real `[OPEN]` blockers** that the other 3 reviewers missed — both Phase 5 / Phase 2 regressions:

- **\[OPEN-1\]** `parseRunArgs` lost macOS `--task-file` containment at `buddy.mjs:294`. `parsePromptArgs:190` calls `isUnderAllowedDir(promptFile)` BEFORE `readPromptFileFdBound`, but `parseRunArgs:294` calls `readTaskFileFdBound(taskFile)` directly — no path-based containment. On Linux, the fd-resolved-path check inside `readFileFdBoundWithLabel` saves us. On macOS, `fdResolvedPath === null` skips the fd-bound check, and the file is read unconditionally. Pre-v0.5.1, macOS hard-failed with "Linux /proc required" — Phase 2's refactor accidentally removed this hard-fail and made macOS silently accept any readable file.

  **Fix:** add `if (!isUnderAllowedDir(taskFile)) return { ok: false, error: ... }` at `buddy.mjs:293`, matching the `parsePromptArgs:190` pattern.

- **\[OPEN-2\]** `runCancel:894-900` stale macOS warning contradicts the Phase 5b fix. The message says "macOS cancel uses best-effort PID match (no /proc cmdline)... macOS-specific verification via 'ps -o command=' is tracked for plan 002." Phase 5b just shipped that verification via `lib/pid-identity.mjs`. The warning is now misinformation.

  **Fix:** remove the warning block; replace with a comment noting the cross-platform TOCTOU window between verification and kill.

Both `[OPEN]` items addressed in the round-2 commit alongside this verdict capture.

### Round 2 (HEAD `0dec4f4`) — ✅ ALL FOUR APPROVE

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-Opus 4.7 | ✅ approve (carried from round-1) |
| 2 | Codex | ✅ approve (carried from round-1) |
| 3 | DeepSeek V4 Flash | ✅ approve — both `[OPEN]` items confirmed `[RESOLVED]`, no new issues |
| 4 | GLM 5.1 | ✅ approve (carried from round-1) |

**\[opencode:deepseek-v4-flash r2\]:** Both round-1 `[OPEN]` blockers resolved:
- `[OPEN-1] RESOLVED` — `isUnderAllowedDir(taskFile)` call added at `buddy.mjs:303` before `readTaskFileFdBound`, matching the `parsePromptArgs:190` pattern. Error message uses path-based wording ("is not under") without "resolves to".
- `[OPEN-2] RESOLVED` — stale macOS warning at old `buddy.mjs:894-900` replaced with a comment about the cross-platform TOCTOU window. Not misleading anymore.

No new issues. **Plan-006 cleared for merge.**

## Post-execution report

(To be filled in before shipping.)

| Phase | Status | Commit |
|---|---|---|
| 1 — git --no-ext-diff (6 call sites: scope.mjs:35/124/129/130 + buddy.mjs diffSummary unstaged/staged) | ✅ shipped | `c62669a` |
| 2 — openFdBound primitive + prompt-file + scope.mjs (plus O_NOFOLLOW upgrade for symlink rejection) | ✅ shipped | `e9c464d` |
| 3 — top-level .catch + OPENCODE_BUDDY_TEST_THROW seam | ✅ shipped | `7b720e0` |
| 4 — hooks fail-open ESM ordering | ✅ shipped | `41a22c6` |
| 5 — cancel correctness (two-layer SIGTERM + pid-identity helper + dynamic import in session-start + OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS + OPENCODE_BUDDY_TEST_PID_NEVER_OURS seams) | ✅ shipped | `f1723ac` |
| 6 — version bump + CHANGELOG + README + post-exec report | this commit | — |
| Plan review round 1 | ⚠️ 4-of-4 needs-attention | `eb0ef03` |
| Plan review round 2 | ⚠️ 2-of-4 needs-attention | `6585a0e` |
| Plan review round 3 | ⚠️ 1-of-4 needs-attention | `961681d` |
| Plan review round 4 (final) | ✅ 4-of-4 approve | `dd8804e` |
| 4-way code review | TBD | — |

### Test count history

| After phase | Total | Pass | New |
|---|---|---|---|
| baseline (post-v0.5.0) | 257 | 254 | — |
| Phase 1 (H1) | 259 | 256 | +2 |
| Phase 2 (H2 + M1) | 268 | 265 | +9 |
| Phase 3 (C1) | 272 | 269 | +4 |
| Phase 4 (H4) | 274 | 271 | +2 |
| Phase 5 (H3 + C2 + M2) | 286 | 283 | +12 |

**Final: 286 tests / 283 pass / 3 e2e skipped / 0 fail. +29 new tests across plan-006.**

### Plan deviations (documented in commit messages)

- Phase 2: plan called for `openFdBound + fstat.isFile()` to reject symlinks, but
  Node's `openSync` follows symlinks by default — so `fstat.isFile()` returns
  true for the symlink TARGET, defeating the symlink-rejection intent. Added a
  `nofollow` option to `openFdBound` (uses `O_NOFOLLOW`) which correctly rejects
  symlinks at open time. `scope.mjs` uses `nofollow: true`; `prompt-file` /
  `task-file` callers use the default (relying on fd-resolved-path containment).
  Reviewers didn't catch this subtle issue across 4 plan-review rounds; surfaced
  during implementation.
