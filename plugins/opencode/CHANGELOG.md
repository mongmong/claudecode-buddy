# Changelog

All notable changes to the opencode plugin are documented here.

## 0.3.0 — Review session continuity

Implemented per `docs/plans/002-review-session-continuity.md`. Plan converged after 13 rounds of Codex review + 8 rounds of opencode/deepseek-v4-pro review, including a round-6 design pivot that dropped layered stale-lock-reclamation defenses in favour of a pure mkdir-EEXIST primitive with manual-rm recovery (auto-reclamation queued for plan 004).

### Added
- Per-`(plan-or-branch, role, model)` opencode session continuity. Successive `/opencode:review` and `/opencode:run` invocations on the same plan/branch resume the prior opencode session via `--session <id>`, so reviewers/runs build on prior reasoning across rounds.
- Rule-based session-key derivation (no LLM in the dispatch path): `feature/plan-NNN-*` → `plan-NNN`; other branches → `branch-<sanitised-branch-name>`; non-git → `scratch`. Sanitisation: lowercase + `[a-z0-9-]+` collapse + dash trim.
- `--session-key <name>` flag — override the rule (e.g., bridge across branches; scope ad-hoc work on `main`).
- `--reset` flag — delete the stored session-id before dispatch, run fresh, save the new id. Recovery primitive for confused reviewer sessions.
- `--no-session` flag — skip reuse for THIS call without deletion (one-off detached question that doesn't pollute the running thread).
- All three flags work on both `/opencode:review` and `/opencode:run`.
- `lib/sessions.mjs` — session-id storage CRUD with atomic `.tmp+rename` writes, key derivation, and the simplified mkdir-EEXIST advisory lock primitive.
- `lib/session-capture.mjs` — three capture mechanisms: `verifySessionExists` (pre-flight via `opencode session list --format json`), `captureSessionIdFromStderr` (PRIMARY post-run capture from opencode's `service=session id=ses_...` log line; deterministic per-process), `captureLatestSessionForCwd` (FALLBACK only when stderr parse fails; cwd-realpath-filtered).
- `lib/review-dispatch.mjs` — high-level `dispatchOpencode({...})` composes pre-flight + lock acquisition + invocation + capture + save. Lock contention triggers degraded mode (fresh + no save) rather than corrupting continuity. Stale-session detection in stderr triggers automatic retry without `--session`.
- D-010 architecture decision: review session continuity is per-`(plan-or-branch, role, model)`, with mkdir-EEXIST locking and manual-rm recovery for stranded locks.

### Changed
- `runReview`, `runRun` (foreground), and `runRunBackground` ALL route through `dispatchOpencode`. The dispatcher owns lock acquisition + pre-flight + capture + save in one place.
- Background path: parent (`runRunBackground`) acquires the lock + verifies the session BEFORE spawning the supervisor. Parent registers `supervisor.once("error" | "spawn")` for the lock-handoff so spawn-time failures don't strand the lock; on success ownership transfers to the supervisor.
- Supervisor argv extends from 4 positionals to 9 (`jobId, projectDir, binary, cwd, role, sessionKey, model, noSession, degraded, ...opencodeArgs`). Supervisor restructured per ESM ordering: top-level static built-in imports, single unified `uncaughtException` handler (replaces v0.2.0's separate handler — does lock release + job-record-failed + supervisor-error breadcrumb in one place), then dynamic `await import(...)` for own modules. The unified crash handler dodges the dual-handler race that left jobs stuck `running` on supervisor crash.
- `invokeOpencodeRaw` now threads `stderr` and `exit_code` on EVERY resolution path (success, non-zero exit, child error, timeout). Empty-text → `ok:true` with empty body (was `ok:false`); the dispatcher's stale-session detection uses this to recognise opencode's silent stale-session failure mode (exit 0 + empty body + `Session not found` in stderr).
- `parseReviewArgs` and `parseRunArgs` accept `--session-key`, `--reset`, `--no-session`. `--reset` and `--no-session` are mutually exclusive (rejected with exit 2).

### Test counts
- Plan 001 baseline: 152 tests.
- Plan 002 adds: 51 (+32 sessions.test.mjs + 11 session-capture.test.mjs + 8 review-dispatch.test.mjs).
- v0.3.0: **203 tests**, 200 pass, 3 e2e skipped.

### Architecture decisions recorded
- **D-010** — review session continuity is per-(plan-or-branch, role, model); rule-based key derivation; pure mkdir-EEXIST advisory lock with manual-rm recovery (auto-reclaim queued for plan 004).

### Known limitations
- **No auto-reclamation of stranded locks.** A dispatch that crashes without releasing the lock requires manual `rm -rf <path>.lock`. The error message on the next acquisition includes the exact recovery command. Auto-reclaim queued for plan 004 with proper `flock(2)` semantics.
- **Capture fallback under same-cwd-different-tuple races** (e.g., parallel `/opencode:review` + `/opencode:run`): when stderr capture fails (only happens if opencode's log format changes), the session-list-cwd-filtered fallback can pick the wrong session. Stderr capture is primary precisely because it's deterministic per-process; this is a fallback-only edge case.
- **macOS case-insensitive realpath comparison** in `captureLatestSessionForCwd` is best-effort. Pathological mixed-case symlink chains are out of scope for v0.3.0.
- **Background supervisor module-load gap**: if the supervisor process forks successfully but throws during ESM module evaluation BEFORE its `uncaughtException` handler registers, the lock is stranded. The handler is registered as early as possible (top of supervisor.mjs after built-in static imports), so the window is microseconds — but documented for transparency.

### Deferred to future plans
- `/opencode:sessions` slash command (list + clear) — plan 004+ (purely ergonomics).
- `--fork` flag (branch from current state into a new session) — plan 004+.
- Auto-prune of stale `.session-id` files older than N days — plan 004+.
- Proper `flock(2)`-backed lock primitives with auto-reclamation — plan 004 (replaces the current best-effort mkdir-EEXIST + manual-rm recovery).
- Adversarial-review + Stop-hook review gate + macOS-parity for cancel/TOCTOU + flock-based serialization — plan 003 (renumbered from former plan-002 slot, since plan 002 was reclaimed for session continuity).

## 0.2.0 — Write-capable run + background tasks + local install

Implemented per `docs/plans/001-opencode-run-and-background.md`. Plan converged after 6 dual-review rounds (Codex + opencode/deepseek-v4-pro per D-004's plan-review pipeline); 14 unique BLOCKERS, ~30 SHOULD-FIX, ~12 NICE-TO-HAVE addressed before approval. Branch then passed the three-reviewer code-review gate (Codex + opencode/deepseek-v4-flash + opencode/glm-5.1) with all Must Fix and Should Fix items resolved before this release.

### Added
- `/opencode:run` slash command (write-capable, foreground or `--background`, with per-invocation model picker and `--yolo` opt-in for `--dangerously-skip-permissions`).
- `/opencode:status` / `/opencode:result` / `/opencode:cancel` slash commands for background-job lifecycle.
- `opencode:opencode-run` subagent for programmatic write-capable dispatch (mirrors `opencode-review`'s heredoc + `--task-file` pattern).
- `lib/jobs.mjs` — job-record CRUD with atomic `.tmp+rename` writes, optional `expectedStatus` CAS, JOB_ID_RE path-traversal defense.
- `lib/supervisor.mjs` — detached supervisor for `--background` runs. Owns one opencode child, parses NDJSON events to extract assistant text, atomically updates job state with the REAL exit code on close, line-by-line drains stdoutBuf so trailing partial lines are captured.
- `lib/invoke.mjs` — `invokeOpencodeRaw` exported for callers (`runRun`) that need to control whether `--dangerously-skip-permissions` is included.
- `hooks/` — `SessionStart` (orphan-job detection) and `SessionEnd` (mark in-flight as session-ended). Both read `{cwd}` from stdin per Claude Code's hook contract.
- Workspace-level `scripts/install-local.sh` and `scripts/uninstall-local.sh` for symlink-based local install into `~/.claude/plugins/marketplaces/claudecode-buddy-local/`. Idempotent; refuses to clobber non-symlinks; uses Node (no jq dependency) for safe `marketplace.json` construction.

### Changed
- **Renamed** `scripts/opencode-companion.mjs` → `scripts/buddy.mjs` per architecture decision D-009. Internal change; user-facing slash commands and subagent names are unchanged.
- New runtime state directory: `<project>/.claudecode-buddy/opencode/jobs/<id>.json` (per D-008). Workspace-shared dir convention; future plugins use the same root.
- `--task-file` reading now TOCTOU-safe via `openSync` + `realpathSync(/proc/self/fd/<N>)` fd-bound resolution (Linux).
- `/opencode:cancel` uses process-group SIGTERM with 2-second SIGKILL escalation via detached helper. Linux `pidIsOurSupervisor` verifies `/proc/<pid>/cmdline` contains `buddy-supervisor` AND the jobId before signaling.
- `runRun` enforces `--yolo` in non-interactive contexts (subagent, CI, piped stderr) and ALWAYS for `--background`.

### Architecture decisions recorded
- **D-008** — workspace-shared plugin runtime state directory (`<project>/.claudecode-buddy/<plugin>/...`).
- **D-009** — plugin runtime entry point named `scripts/buddy.mjs`.

### Known limitations
- macOS cancel is best-effort (no `/proc`); cmdline verification deferred to plan 002.
- CAS is best-effort; flock-based serialization deferred to plan 002.
- `--task-file` TOCTOU defense is Linux-only; macOS support deferred to plan 002.

### Deferred to future plans
- `/opencode:adversarial-review`, optional Stop-hook review gate — plan 002.
- Marketplace publishing (formal release flow) — separate later plan.
- Review session continuity (per-plan + per-role + per-model session keys) — separate workflow plan queued.

## 0.1.0 — Initial scaffold (read-only review)

Implemented per `docs/plans/000-opencode-plugin-v1-scaffold.md`.

### Added
- `/opencode:review` slash command (foreground only, with per-invocation model picker via AskUserQuestion).
- `/opencode:setup` slash command.
- `opencode:opencode-review` subagent for programmatic dispatch (free-form prompt forwarding via heredoc + temp file under `$TMPDIR/opencode-prompts/run-XXXXXX/`, with defense-in-depth path validation).
- Internal `opencode-cli-runtime` skill.
- Node companion script (`scripts/buddy.mjs`) wrapping `opencode run --format json`. Subcommands: `setup`, `models`, `review`, `prompt`.
- Hybrid output convention — Markdown findings + fenced JSON trailer for the verdict signal.
- `schemas/review-trailer.schema.json` documenting the trailer shape.
- Workspace-level `tests/` harness using `node:test`, with mock fixtures for the opencode binary and a gated end-to-end suite (`OPENCODE_E2E=1`).

### Deferred to future plans
- Write-capable rescue, background tasks, `/opencode:status` / `/opencode:result` / `/opencode:cancel` — plan 001.
- Adversarial-review and optional Stop-hook review gate — plan 002.
- Marketplace publishing — separate later plan.
