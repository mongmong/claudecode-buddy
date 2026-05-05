# Changelog

All notable changes to the opencode plugin are documented here.

## 0.5.0 — `--variant` reasoning-effort flag + opencode binary auto-discovery

### Added
- `--variant <level>` flag on `/opencode:review`, `/opencode:run`, the `prompt` subcommand, and both subagents (`opencode:opencode-review`, `opencode:opencode-run`). Forwards opencode's `--variant` argument verbatim to the underlying provider — opencode documents `high`, `max`, and `minimal` as common values, but the exact set is provider-specific. The plugin does not validate the value (provider decides what's accepted).
- `OPENCODE_VARIANT` env var fallback for the `prompt` subcommand (mirrors the existing `OPENCODE_MODEL` pattern). The explicit `--variant` flag wins over the env var.
- **Automatic opencode binary discovery.** When `OPENCODE_BIN` is unset and `opencode` is not on `PATH`, the plugin now scans a documented list of common install locations (`~/.opencode/bin/opencode` — the official installer's drop point — `~/.local/bin/`, `~/.bun/bin/`, `~/.npm-global/bin/`, `~/.npm/bin/`, `/opt/homebrew/bin/`, `/usr/local/bin/`, `/usr/bin/`) and uses the first existing + executable hit. Resolution order: `OPENCODE_BIN` → `PATH` → well-known scan. The "not installed" guidance now lists every location it checked.
- 9 new tests in `tests/opencode/variant.test.mjs` covering --variant forwarding, default-omission, missing-value rejection, duplicate-flag rejection, and env-var fallback / precedence.
- 9 new tests in `tests/opencode/cli-detection.test.mjs` covering scan-path fallback, scan-order precedence, OPENCODE_BIN-wins-over-scan, PATH-wins-over-scan, non-executable rejection, directory-not-file rejection, and guidance-text content.
- New fixture `tests/opencode/fixtures/mock-opencode-record-args.mjs` — records `process.argv` to `$OPENCODE_RECORD_ARGS_PATH` so tests can assert exactly what's forwarded to the spawned opencode binary.

### Changed
- `parseReviewArgs`, `parseRunArgs`, `parsePromptArgs` accept `--variant`. `parseRunArgs` extends its duplicate-flag guard to cover `--variant`.
- `runReview`, `runRun` (foreground), `runRunBackground`, and `invokeOpencode` push `--variant <value>` after `--model` in the spawned argv when set.
- `--variant` does NOT change the session-continuity tuple (key still `(plan-or-branch, role, model)`), so a single session can mix variant levels across rounds.
- `lib/cli-detection.mjs` exports a frozen `WELL_KNOWN_INSTALL_PATHS` constant for tests + downstream consumers that want to inspect the canonical scan order without hardcoding it.

### Test counts
- v0.4.0 baseline: 234 tests (231 pass + 3 e2e skipped).
- v0.5.0 adds: 9 variant tests + 9 cli-detection tests.
- v0.5.0: **252 tests pass**, 3 e2e skipped, 0 fail.

## 0.4.0 — Adversarial-style review + opt-in Stop-hook gate

Implemented per `docs/plans/003-review-experience.md`. Plan converged after 5 rounds of Codex review + 5 rounds of opencode/deepseek-v4-pro review. Both reviewers approved at round 5.

### Distribution change (mid-release infrastructure, plan 004)

Mid-release, the workspace's plugin distribution mechanism was reworked. `.claude-plugin/marketplace.json` was added at the repo root; `scripts/install-local.sh` and `scripts/uninstall-local.sh` were deleted. Plugin behavior unchanged from v0.4.0; this is purely a packaging fix. See [`docs/architecture/decisions.md` → D-012](../../docs/architecture/decisions.md) for the rationale and the workspace [`README.md`](../../README.md#install) for the new install instructions. Users who previously ran `bash scripts/install-local.sh` should follow the README's "Migrating from a previous local install" section to clean up the stale `~/.claude/plugins/marketplaces/claudecode-buddy-local/` symlinks.

### Added
- `--style <friendly|adversarial>` flag on `/opencode:review`. Default `friendly` (current v0.3.0 behavior). `--style adversarial` prepends the adversarial prompt template (`prompts/adversarial-review.md`) and routes session continuity through `role: review-adversarial` (distinct tuple from `review`). Backwards-compatible — no migration needed for existing usage.
- Opt-in Stop-hook review gate. When enabled (`/opencode:gate on`), every Claude Code `Stop` event runs a review of the working-tree state + the assistant's last message via `dispatchOpencode`; `needs-attention` verdicts block Claude's stop with `{decision:"block", reason:...}`. Smart-skips read-only turns (no git changes) AND turns where the only changes are the dispatcher's own session-id writes under `.claudecode-buddy/`. Fails open on review-system errors.
- `/opencode:gate on|off|status` slash command — workspace toggle for the Stop-hook gate.
- `lib/config.mjs` — workspace plugin config CRUD (`<project>/.claudecode-buddy/opencode/config.json`). Establishes the workspace-config convention from D-011: each plugin owns its own config file under the shared `.claudecode-buddy/` root.
- `prompts/adversarial-review.md` — hostile-reviewer system prompt template.
- `prompts/stop-review-gate.md` — Stop-hook gate prompt template (instructs the reviewer to verify assistant claims against the working tree using either git or filesystem inspection).
- `scripts/stop-review-gate-hook.mjs` — the Stop-hook implementation. ESM ordering matches plan-002 supervisor.mjs (static imports of node:* only, register fail-open handlers, dynamic await imports of own modules).
- D-011 — Stop-hook review gate is opt-in, fails open, smart-skips read-only turns. Establishes the workspace-config-file convention. Documents the threat-model rationale ("advisory development gate, NOT a security control") for the divergence from codex's fail-closed design.

### Changed
- `parseReviewArgs` accepts `--style friendly|adversarial`. Unknown values rejected with exit 2.
- `runReview` forwards `style` to `dispatchOpencode` (passes the matching template via `buildReviewPrompt`) and uses `role: "review-adversarial"` when style=adversarial.
- `lib/prompt.mjs:buildReviewPrompt` accepts `style` parameter; loads matching prompt template from `plugins/opencode/prompts/<style>-review.md` and prepends it to the canonical review framing. Friendly is no-prefix (zero behavior change vs v0.3.0).
- `hooks/hooks.json` registers the Stop-hook entry alongside existing SessionStart/SessionEnd hooks. 900s timeout matches codex's; inner dispatcher timeout (5min) fires first in practice.

### Test counts
- Plan 002 baseline: 205 tests (200 pass, 3 e2e skipped, 2 plan-001 fix tests).
- Plan 003 adds: 26 new tests (config: 10, --style: 3, gate-cmd: 5, stop-gate: 8).
- v0.4.0: **231 tests**, 228 pass, 3 e2e skipped.

### Architecture decisions recorded
- **D-011** — Stop-hook review gate is opt-in, fails open, smart-skips read-only turns via git state. Workspace-config convention: `<project>/.claudecode-buddy/<plugin>/config.json`.

### Known limitations
- **Edited-then-reverted edge case:** if the assistant claims edits but the working tree is clean (e.g., edits applied then reverted within the same turn), the gate smart-skips. The reviewer would have nothing to verify against, so this is correct behavior — but documented so users don't expect the gate to catch it.
- **Concurrent Claude Code sessions in the same workspace:** both opt-in gates would fire on each Stop. The dispatcher's lock-degraded-mode handles the race correctly (the second gate runs without continuity but doesn't corrupt the first's stored session-id).
- **Module-load gap:** narrow window between hook `spawn()` and the top-of-file `uncaughtException` handler registering. Static-builtins-only imports minimise this. Same pattern as plan-002 supervisor.mjs.
- **Soft-skip on assistant-message regex was deliberately dropped** during round 2 (false-positive risk on real change turns). Meta-skip on `.claudecode-buddy/`-only changes covers the dominant reviewer-dispatching case.

### Deferred to future plans
- Per-session env-var override for the gate (`OPENCODE_BUDDY_STOP_GATE=off`) — plan 005+ if usage shows the workspace flag is too coarse.
- macOS parity for `pidIsOurSupervisor` and `--task-file` TOCTOU defense — plan 004.
- `flock(2)`-backed serialization for `lib/jobs.mjs:updateJob` and the session lock — plan 005.
- `--task` stdin-as-prompt support — plan 004.

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
- `runReview` and `runRun` (foreground) route through `dispatchOpencode`. `runRunBackground` implements the same contract across the parent-supervisor boundary: parent does pre-flight + lock acquisition; supervisor (in a separate process) owns capture + save + lock release at close. Same defenses (pre-flight, stale-stderr detection, --no-session save gate) apply uniformly.
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
