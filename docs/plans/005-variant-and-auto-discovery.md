# Plan 005 — `--variant` flag + opencode binary auto-discovery (v0.5.0)

> **Note:** This plan was written retroactively because both changes were small / well-scoped (a flag addition + a runner-detection fallback) and didn't warrant a formal plan-write → 4-way plan-review → implement cycle.
> The plan file exists primarily to host the post-execution report and the 4-way code-review verdicts in the canonical location, per the workspace's review policy.
> Future small changes that bypass the plan-write step should still land their code review here, in `docs/plans/NNN-<topic>.md ## Code Review`.

## Goals

1. Expose opencode's `--variant <level>` flag through the plugin so users can request provider-specific reasoning effort (e.g. `high`, `max`, `minimal`) without changing models.
2. Make the plugin "just work" after a fresh `curl https://opencode.ai/install | bash` install: auto-discover the binary at common install locations when it's not on `PATH` and `OPENCODE_BIN` isn't set.

## Surface

### `--variant` (commit 1e6ea25)

- New flag accepted by `parseReviewArgs`, `parseRunArgs`, `parsePromptArgs`.
  Free-form string forwarded verbatim to opencode (provider-specific; plugin does not validate).
- Forwarded in argv after `--model` by `runReview`, `runRun` (foreground), `runRunBackground`, and `invokeOpencode`.
- `OPENCODE_VARIANT` env var fallback for the `prompt` subcommand only (mirrors `OPENCODE_MODEL`). Explicit flag wins over env.
- `parseRunArgs` duplicate-flag guard extended to `--variant`.
- Does NOT change the session-continuity tuple — same session can mix variant levels.
- Slash-command + subagent + README + CHANGELOG updates. Plugin + marketplace versions bumped 0.4.0 → 0.5.0.

### Auto-discovery (commit dbc3522)

- `lib/cli-detection.mjs` adds a third resolution step after `OPENCODE_BIN` and `PATH`:
  scan a documented list of well-known install locations and use the first existing + executable hit.
- Scan order (most-likely-correct first): `~/.opencode/bin/opencode`, `~/.local/bin/opencode`, `~/.bun/bin/opencode`, `~/.npm-global/bin/opencode`, `~/.npm/bin/opencode`, `/opt/homebrew/bin/opencode`, `/usr/local/bin/opencode`, `/usr/bin/opencode`.
- Only matches regular executable files (mode bit `0o111` set) — directories + non-executables at these paths are skipped.
- "Not installed" guidance enumerates every location checked + reminds about `OPENCODE_BIN`.
- Exports frozen `WELL_KNOWN_INSTALL_PATHS` for tests + introspection.

## Tests

- 9 new tests in `tests/opencode/variant.test.mjs` — forwarding via mock binary that records argv, default-omission, missing-value rejection, duplicate-flag rejection, env-var fallback / precedence.
- 9 new tests in `tests/opencode/cli-detection.test.mjs` — scan-fallback, scan-order, OPENCODE_BIN-wins, PATH-wins, executable-bit gating, directory rejection, guidance content, frozen export.
- New fixture `tests/opencode/fixtures/mock-opencode-record-args.mjs` records argv to `$OPENCODE_RECORD_ARGS_PATH`.

## Test counts

| Stage | Count |
|---|---|
| v0.4.0 baseline | 234 (231 pass, 3 e2e skipped) |
| + variant tests | 243 |
| + cli-detection tests | **252** (252 pass, 3 e2e skipped, 0 fail) |

## Plan Review

Skipped — both changes are small, well-scoped, and not "substantial" in the CLAUDE.md sense (flag addition + runner fallback).
The 4-way plan-review gate is reserved for plans that introduce new commands, runner refactors, or cross-cutting architectural change.

## Code Review

Per the v0.5.0+ workspace policy, four reviewers run in parallel:

| # | Reviewer | Model |
|---|---|---|
| 1 | Self-review (Opus 4.7) | claude-opus-4-7 |
| 2 | Codex | Codex default |
| 3 | DeepSeek V4 Flash (via opencode) | deepseek/deepseek-v4-flash |
| 4 | GLM 5.1 (via opencode) | volcengine-plan/glm-5.1 |

### \[self-opus\] — TBD

To be filled in by Claude on Opus 4.7 reviewing the diff with fresh eyes before merge.

### \[codex\] — TBD

To be filled in by `codex:codex-rescue` subagent dispatch.

### \[opencode:deepseek-v4-flash\] — TBD

To be filled in by `opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-flash`.

### \[opencode:glm-5.1\] — TBD

To be filled in by `opencode:opencode-review` subagent with `--model volcengine-plan/glm-5.1`.

## Post-execution report

| Phase | Status | Commit |
|---|---|---|
| `--variant` flag implementation + tests + docs | ✅ shipped | `1e6ea25` |
| Auto-discovery + tests + docs | ✅ shipped | `dbc3522` |
| Plan file (this document) + 4-way code review | 🟡 in progress | — |

### What changed (file-level)

- `plugins/opencode/scripts/buddy.mjs` — three parsers + four dispatch sites, all gated on `args.variant`.
- `plugins/opencode/scripts/lib/invoke.mjs` — `invokeOpencode` accepts `variant` param, pushes `--variant` after `--model`.
- `plugins/opencode/scripts/lib/cli-detection.mjs` — full rewrite of resolution. Adds `WELL_KNOWN_PATHS`, `expandHome`, `isExecutableFile`, `scanWellKnownPaths`, `pathHasOpencode`, `buildGuidance` helpers.
- Slash commands (`commands/review.md`, `commands/run.md`) + subagents (`agents/opencode-review.md`, `agents/opencode-run.md`) — `--variant` documented in argument-hint, supported-flags list, and a "reasoning effort" section.
- `plugins/opencode/README.md` — `--variant` section + auto-discovery requirement update + `OPENCODE_VARIANT` env-var row.
- `plugins/opencode/CHANGELOG.md` — v0.5.0 entry.
- Plugin + marketplace versions bumped 0.4.0 → 0.5.0.

### Known limitations / explicit non-goals

- **Windows install paths** are not scanned. `~/.opencode/bin/` works on Windows (the official installer puts it there) but `%APPDATA%\opencode\bin\opencode.exe` and similar are not in `WELL_KNOWN_PATHS`. Out of scope for v0.5.0; the `OPENCODE_BIN` escape hatch covers the affected case.
- **Provider-specific variant validation** is intentionally absent. opencode forwards `--variant` to the provider unchanged; the provider may silently drop unknown variants. Documented in the plugin README.
- **Session-continuity tuple is unchanged.** A session that switched models mid-stream would already have to restart; mixing variant levels does NOT trigger that, by design (variant is "how hard to think", not "what model").
