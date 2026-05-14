# codex plugin

Claude Code plugin that wraps the [codex](https://codex.ai) CLI as an independent code-review and write-capable coding agent. Parity with the opencode plugin's v0.5.1 surface.

## Status

**Initial release in progress** — plan-007 (`docs/plans/007-codex-plugin-parity.md`) is mid-implementation. Phase 1 (skeleton + manifests + hook scripts) has landed; Phases 2-8 will add the runtime + tests + docs.

For the canonical reference plugin layout and feature set, see [`plugins/opencode/README.md`](../opencode/README.md). The codex plugin mirrors that interface — same slash commands, same subagents, same flag shapes, adapted to codex CLI semantics (`codex exec --json` instead of `opencode run --format json`, UUID session-ids instead of `ses_*`, `--sandbox` levels instead of `--dangerously-skip-permissions`).

## Install

The codex plugin lives in the same marketplace as opencode. Once you've registered claudecode-buddy:

```
/plugin install codex@claudecode-buddy
```

Restart Claude Code.

**Migrating from openai-codex:** see workspace `README.md` once the Phase 8 migration guide lands. The short version: uninstall openai-codex first to avoid namespace collision, then install ours.

## Requirements

- Node ≥ 18.18.
- codex CLI installed and on PATH (or set `CODEX_BIN` to the absolute binary path; auto-discovery scans `~/.codex/bin/codex` and other common install paths).
- A default model in `~/.codex/config.toml` (override via `CODEX_HOME` env).

## What you'll get (Phases 2-8 in progress)

- `/codex:review` — code review of the working tree or branch diff.
- `/codex:run` — write-capable task delegation (foreground or `--background`). Default sandbox is `read-only`; `--yolo` upgrades to `workspace-write` (cwd-confined).
- `/codex:rescue` — parity with openai-codex's command of the same name.
- `/codex:status` / `/codex:result` / `/codex:cancel` — background-job lifecycle.
- `/codex:gate` — opt-in Stop-hook review gate.
- `/codex:setup` — verify codex CLI + default model.
- `codex:codex-review` / `codex:codex-run` subagents — programmatic dispatch.
- `codex:codex-rescue` subagent — literal-copy alias of `codex-review` for backward compatibility with prior CLAUDE.md references.

See `CHANGELOG.md` for what's in this version.
