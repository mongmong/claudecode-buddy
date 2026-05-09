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
| H5 | high | Job-state CAS TOCTOU. Already documented as known-limitation; proper `flock(2)` ships in plan-007 (queued). |
| H6 | high | Lock-handoff window between `spawn()` and `"spawn"` event. Narrow window, requires `uncaughtException` registration in parent — invasive. Plan-007. |
| H7 | high | Every subcommand exits 0 on failure (33 sites). Meaty enough to warrant its own plan-007a focused on exit-code propagation + the test matrix it requires. |
| H8 | high | Timeout kills only direct opencode child. Process-group rework is non-trivial. Plan-007. |
| M3-M10 | medium | Quality-of-life + perf items. Plan-008 polish. |
| L1-L11 | low | Plan-008+ polish. |

## Phase 1 — `git diff --no-ext-diff` (H1)

**Goal:** add `--no-ext-diff` and `--no-textconv` to every `git diff` invocation in the plugin so untrusted-repo `diff.external` / textconv drivers cannot execute arbitrary code when `/opencode:review` builds the prompt.

**Files:**
- Modify: `plugins/opencode/scripts/lib/scope.mjs:124,129-130` (3 `git diff` call sites).
- Modify: `plugins/opencode/scripts/buddy.mjs` — `diffSummary(cwd)` calls `git diff --stat`. Audit and add the flags.
- Test: `tests/opencode/scope.test.mjs` — add a test that invokes the diff under a fixture repo with `diff.external` set to a binary that would fail (e.g., `/bin/false`); verify the diff still succeeds (proves `--no-ext-diff` is taking effect).

**Steps:**

- [ ] Step 1: write the failing test
  Create a fixture repo, set `git config diff.external /bin/false`, modify a file, call `getDiff({scope: "working-tree", base: null, cwd: fixtureDir})`. Assert `result.ok === true` AND the diff body contains the modification.
  Without `--no-ext-diff`, `/bin/false` exits 1, git aborts the diff with an error, and the test fails.
- [ ] Step 2: run test to confirm RED
  `node --test tests/opencode/scope.test.mjs` → expect FAIL (without the fix).
- [ ] Step 3: apply the fix
  In `scope.mjs`, change every `runGit(cwd, ["diff", ...])` to `runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", ...])`. Apply the same pair to `git diff --shortstat` / `git diff --stat` calls in `buddy.mjs:diffSummary`.
- [ ] Step 4: run test → GREEN
- [ ] Step 5: full suite still green
  `node --test tests/`
- [ ] Step 6: commit
  `feat(opencode): add --no-ext-diff to all git diff calls (closes RCE H1)`

## Phase 2 — fd-bound `--prompt-file` + `scope.mjs` untracked (H2 + M1)

**Goal:** close the realpath→read TOCTOU window for both file-input paths.
`--task-file` already uses `readTaskFileFdBound` — refactor that helper into reusable form and apply to `--prompt-file` + `scope.mjs:readUntrackedAsDiff`.

**Files:**
- Modify: `plugins/opencode/scripts/buddy.mjs` — extract `readFdBoundUnderAllowedDir` from `readTaskFileFdBound` so it accepts a base-dir parameter (or is callable from non-prompt contexts).
- Modify: `parsePromptArgs` (`buddy.mjs:178-189`) to use the extracted helper instead of the bare `readFileSync` after `isUnderAllowedDir`.
- Modify: `plugins/opencode/scripts/lib/scope.mjs:80-100` — replace `lstatSync(fullPath)` + `readFileSync(fullPath)` with an `openSync` + `fstatSync(fd)` + `readFileSync(fd)` flow. The fstat-on-fd rejects symlinks-via-mode + the read happens on the same fd.
- Test: `tests/opencode/prompt-cmd.test.mjs` — add a test that creates a regular file in `$TMPDIR/opencode-prompts/`, races a swap-to-symlink, asserts the read returns the original-file contents OR an error (NEVER the symlink target). The race is hard to deterministically trigger without injection — accept a deterministic equivalent: replace the file with a symlink BEFORE the read, verify the fd-bound path (resolved via `/proc/self/fd/`) is still the original file. Linux-only.
- Test: `tests/opencode/scope.test.mjs` — add a test that creates an untracked symlink AFTER `lstatSync` would have run (deterministic substitute: replace a regular file's content via `writeFileSync` between `openSync` and `readFileSync(fd)`; assert the read returns the original content via fd, not the new content). Demonstrates fstat-on-fd safety.

**Steps:** (see Phase 1 for the TDD discipline; same red-green-refactor-commit cycle)

- [ ] Step 1: write the prompt-file TOCTOU test (red)
- [ ] Step 2: run test → fail (it should pass under the current code only because the swap timing is hard; the deterministic substitute MUST fail under the current code)
- [ ] Step 3: extract `readFdBoundUnderAllowedDir(path, baseDir)` from `readTaskFileFdBound` (Linux-only via `/proc/self/fd/`)
- [ ] Step 4: rewire `parsePromptArgs` to call it (replaces the `readFileSync(promptFile, "utf8")` line)
- [ ] Step 5: run test → green
- [ ] Step 6: write the scope.mjs untracked-file test (red)
- [ ] Step 7: rewrite `readUntrackedAsDiff` to use `openSync` + `fstatSync` + `readFileSync(fd)`
- [ ] Step 8: run test → green
- [ ] Step 9: full suite green
- [ ] Step 10: commit
  `feat(opencode): fd-bound prompt-file + scope.mjs untracked reads (closes H2 + M1)`

**macOS deferred:** the existing `readTaskFileFdBound` is Linux-only (uses `/proc/self/fd/`); the new helper preserves that.
On macOS, fd-bound resolution requires `F_GETPATH` via `fcntl` — out of scope for plan-006; the existing `--task-file` known-limitation note covers both file-input paths after this refactor.

## Phase 3 — `.catch()` on top-level async dispatches (C1)

**Goal:** eliminate the unhandled-rejection footgun in `buddy.mjs`'s top-level dispatch.

**Files:**
- Modify: `plugins/opencode/scripts/buddy.mjs:958,962,964` — wrap each top-level async call in `.catch()`.
- Test: `tests/opencode/run-cmd.test.mjs` (or new `tests/opencode/dispatch.test.mjs`) — inject a mock that throws inside `runReview` to confirm the `.catch` handler engages and the process exits with code 2 (not crash with non-zero unhandled-rejection exit).

**Steps:**

- [ ] Step 1: write the unhandled-rejection test (red)
  Write a fixture that monkey-patches one of the runner functions to throw asynchronously, spawn buddy.mjs, assert exit code 2 (not 1 from unhandled rejection).
- [ ] Step 2: run → fail (current code has no .catch; Node ≥15 exits with code 1 on unhandled rejection)
- [ ] Step 3: apply the .catch
  ```js
  if (subcommand === "review") {
    runReview(rest).catch((err) => { process.stderr.write(`unhandled error: ${err.stack ?? err.message ?? err}\n`); process.exit(2); });
  } else if (subcommand === "prompt") {
    runPrompt(rest).catch((err) => { ... process.exit(2); });
  } else if (subcommand === "run") {
    runRun(rest).catch((err) => { ... process.exit(2); });
  }
  ```
- [ ] Step 4: run → green
- [ ] Step 5: commit
  `fix(opencode): .catch() on top-level async dispatches (closes C1)`

## Phase 4 — Session hooks fail open (H4)

**Goal:** session-start.mjs + session-end.mjs adopt the fail-open ESM ordering already proven in `stop-review-gate-hook.mjs`.

**Files:**
- Modify: `plugins/opencode/hooks/session-start.mjs` — replace static `import { listJobs }` with the static-`node:*`-only + register `uncaughtException` + dynamic `await import("./jobs.mjs")` pattern.
- Modify: `plugins/opencode/hooks/session-end.mjs` — same.
- Test: `tests/opencode/hooks.test.mjs` — add a test that simulates a module-load failure (e.g., monkey-patch the import path or use a fixture that breaks `jobs.mjs`) and asserts the hook exits 0 (fail-open) rather than 1.

**Steps:**

- [ ] Step 1: write the fail-open test for session-start (red)
- [ ] Step 2: run → fail (current static import would crash with non-zero exit)
- [ ] Step 3: rewrite session-start.mjs to match stop-review-gate-hook ordering
- [ ] Step 4: run → green
- [ ] Step 5: same for session-end (red → fix → green)
- [ ] Step 6: commit
  `fix(opencode): session hooks adopt fail-open ESM ordering (closes H4)`

## Phase 5 — Cancel correctness (H3 + C2 + M2)

**Goal:** `/opencode:cancel` no longer strands the session lock, no longer fires SIGTERM at unrelated PIDs on macOS, and orphan detection uses the same cmdline-based identity check.

**Three sub-fixes:**

### 5a. SIGTERM handler in supervisor.mjs (H3)

- The supervisor currently has only `child.on("close")` and `process.on("uncaughtException")`. SIGTERM from `runCancel` kills the supervisor without running either, so the lock dir is orphaned.
- Add `process.on("SIGTERM", () => { releaseLock(); updateJob(...); process.exit(143); });`.
- Same for SIGINT for symmetry.

### 5b. macOS cmdline check (C2)

- `pidIsOurSupervisor` currently returns `true` unconditionally on macOS (`buddy.mjs:367`).
- Replace with `execFileSync("ps", ["-o", "command=", "-p", String(pid)], {...})` and grep for `buddy-supervisor:<jobId>`.
- Linux path (existing `/proc/<pid>/cmdline`) unchanged.

### 5c. Orphan detection cmdline check (M2)

- `session-start.mjs:isAlive(j.pid)` currently treats any live PID as alive-and-ours.
- Refactor `pidIsOurSupervisor` into `lib/pid-identity.mjs` (or similar) and call it from both `runCancel` and `session-start.mjs` orphan detection.
- This means a PID that's alive but isn't our supervisor (PID reuse) is correctly classified as orphan.

**Files:**
- Modify: `plugins/opencode/scripts/lib/supervisor.mjs` — add SIGTERM + SIGINT handlers calling `releaseLock` + `updateJob`.
- Modify: `plugins/opencode/scripts/buddy.mjs:363-381` — extract `pidIsOurSupervisor` into `lib/pid-identity.mjs`. Replace the `return true` macOS branch with `ps -o command=`.
- Create: `plugins/opencode/scripts/lib/pid-identity.mjs` — exported `pidIsOurSupervisor(pid, jobId, env)`.
- Modify: `plugins/opencode/hooks/session-start.mjs` — import `pidIsOurSupervisor` and use it in place of bare `isAlive`.
- Test: `tests/opencode/run-cmd.test.mjs` — extend cancel test to assert that the session lock dir does NOT exist after cancel (proves SIGTERM handler ran).
- Test: `tests/opencode/cancel-cmd.test.mjs` — add a test that simulates a PID-reuse scenario (mock `pidIsOurSupervisor` to return false despite live PID); assert cancel reports "not our supervisor" instead of sending SIGTERM.
- Test: `tests/opencode/hooks.test.mjs` — extend orphan-detection test with PID-reuse simulation.

**Steps:**

- [ ] Step 1: write the SIGTERM-releases-lock test (red)
- [ ] Step 2: run → fail (current cancel strands the lock)
- [ ] Step 3: add SIGTERM handler in supervisor.mjs
- [ ] Step 4: run → green
- [ ] Step 5: write the macOS-cmdline-check test (red, mockable via `OPENCODE_BUDDY_FORCE_PLATFORM=darwin` test hook or similar; if not, skip on Linux + add a Linux-equivalent ps test)
- [ ] Step 6: extract `pidIsOurSupervisor` to `lib/pid-identity.mjs`; add macOS branch
- [ ] Step 7: rewire `runCancel` + `session-start.mjs` to use the extracted helper
- [ ] Step 8: run → green
- [ ] Step 9: commit
  `fix(opencode): cancel correctness — SIGTERM releases lock, macOS cmdline check (closes H3 + C2 + M2)`

## Test count expectations

- Plan-006 adds approximately **8 new tests** across 5 phases:
  - Phase 1: 1 (no-ext-diff)
  - Phase 2: 2 (prompt-file fd-bound, scope.mjs fd-bound)
  - Phase 3: 1 (unhandled-rejection .catch)
  - Phase 4: 2 (session-start, session-end fail-open)
  - Phase 5: 2-3 (SIGTERM-releases-lock, macOS cmdline check, orphan PID-reuse)
- Baseline: 257 (254 pass + 3 e2e skipped). Expected after plan-006: ~265 (262 pass + 3 e2e skipped).

## Documentation updates

- `plugins/opencode/CHANGELOG.md` — new v0.5.1 entry (this is a security/correctness patch release, not a feature release; semver bump justifies patch increment).
- `plugins/opencode/.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` — version 0.5.0 → 0.5.1.
- `plugins/opencode/README.md` — update "Known limitations" section: H1 + H2 + H3 + C2 close; mark H5/H6/H7/H8 as queued for plan-007.

## Plan Review (4-way — to be filled in before implementation)

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-review (Opus 4.7) | TBD |
| 2 | Codex via `codex:codex-rescue` subagent | TBD |
| 3 | DeepSeek V4 Pro via opencode bash escape hatch | TBD |
| 4 | GLM 5.1 via opencode bash escape hatch | TBD |

(Plugin subagent still not loaded in this session → use `opencode run --model X --dangerously-skip-permissions ...` for reviewers 3 and 4.)

## Code Review (4-way — to be filled in after implementation)

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-review (Opus 4.7) | TBD |
| 2 | Codex via `codex:codex-rescue` subagent | TBD |
| 3 | DeepSeek V4 Flash via opencode bash escape hatch | TBD |
| 4 | GLM 5.1 via opencode bash escape hatch | TBD |

## Post-execution report

(To be filled in before shipping.)

| Phase | Status | Commit |
|---|---|---|
| 1 — git --no-ext-diff | TBD | — |
| 2 — fd-bound prompt-file + scope.mjs | TBD | — |
| 3 — top-level .catch | TBD | — |
| 4 — hooks fail-open | TBD | — |
| 5 — cancel correctness | TBD | — |
| 4-way plan review | TBD | — |
| 4-way code review | TBD | — |
| Version bump + CHANGELOG + ship | TBD | — |
