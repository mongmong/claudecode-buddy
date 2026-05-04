# Changelog

All notable changes to the opencode plugin are documented here.

## 0.1.0 — Initial scaffold (read-only review)

Implemented per `docs/plans/000-opencode-plugin-v1-scaffold.md`.

### Added
- `/opencode:review` slash command (foreground only, with per-invocation model picker via AskUserQuestion).
- `/opencode:setup` slash command.
- `opencode:opencode-review` subagent for programmatic dispatch (free-form prompt forwarding via heredoc + temp file under `$TMPDIR/opencode-prompts/run-XXXXXX/`, with defense-in-depth path validation).
- Internal `opencode-cli-runtime` skill.
- Node companion script (`scripts/opencode-companion.mjs`) wrapping `opencode run --format json`. Subcommands: `setup`, `models`, `review`, `prompt`.
- Hybrid output convention — Markdown findings + fenced JSON trailer for the verdict signal.
- `schemas/review-trailer.schema.json` documenting the trailer shape.
- Workspace-level `tests/` harness using `node:test`, with mock fixtures for the opencode binary and a gated end-to-end suite (`OPENCODE_E2E=1`).

### Deferred to future plans
- Write-capable rescue, background tasks, `/opencode:status` / `/opencode:result` / `/opencode:cancel` — plan 001.
- Adversarial-review and optional Stop-hook review gate — plan 002.
- Marketplace publishing — separate later plan.
