# Changelog

All notable changes to the opencode plugin are documented here.

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
