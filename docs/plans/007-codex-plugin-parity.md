# Plan 007 — Codex plugin (full v0.5.1 parity with opencode plugin)

## Background

The opencode plugin is the workspace's mature reference for wrapping a third-party coding CLI inside Claude Code. v0.5.1 ships 7 slash commands, 2 subagents, 1 skill, 3 hooks, ~2700 lines of runtime, ~4300 lines of tests, session continuity, background jobs, fd-bound TOCTOU defenses, fail-open hooks, RCE-via-`diff.external` defenses, and a Stop-hook review gate.

A third-party openai-codex plugin is already installed at `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/` providing `/codex:*` commands and `codex:codex-rescue`.
Plan-007 **replaces** that plugin with a claudecode-buddy-owned codex plugin at `plugins/codex/`, interface-parity with the opencode plugin v0.5.1.

The user-facing namespace `/codex:*` is preserved (so existing CLAUDE.md references to `codex:codex-rescue` / `/codex:review` continue to resolve). The subagent migrates from `codex:codex-rescue` → `codex:codex-review` for parity with `opencode:opencode-review`; `codex-rescue` is kept as an alias for backward-compatibility with the CLAUDE.md text.

## Scope (in)

- Replace openai-codex by owning `/codex:*` namespace in claudecode-buddy.
- Full feature parity with opencode plugin v0.5.1 — same slash commands, same subagents, same skill, same hooks, same flags (adapted to codex CLI surface), same session-continuity semantics, same RCE / TOCTOU / SIGTERM defenses.
- Cross-cutting infrastructure shared with opencode where structurally identical (`lib/fd-bound.mjs`, `lib/pid-identity.mjs`, `lib/jobs.mjs`, `lib/sessions.mjs`) — see "Code-sharing strategy" below.
- Marketplace entry + version `0.5.1` matching opencode's release line.
- Migration guide: how users move from openai-codex to claudecode-buddy/codex.
- Update workspace CLAUDE.md to point at the new plugin's dispatch paths.

## Scope (out — deferred to future plans)

- Anything not in opencode v0.5.1. The deferred-from-opencode items (H5/H6/H7/H8 from the bug audit, M3-M10, L1-L11) are not part of this parity baseline; they ship together with opencode's plan-007/008 when those land.
- Codex-specific features that have no opencode analog (e.g. `codex apply`, `codex fork`, `codex cloud`). These can be added in plan-008+ if useful.
- The macOS F_GETPATH-based fd-bound defense (still queued for plan-009+ at opencode level).

## Codex CLI surface — deltas vs opencode

Both CLIs wrap an LLM. The dispatch shape is structurally the same (spawn → capture stdout/stderr → parse events → return assistant text), but the argv differs:

| Concept | opencode CLI | codex CLI |
|---|---|---|
| Non-interactive run | `opencode run [PROMPT]` | `codex exec [PROMPT]` |
| Code review | (uses `opencode run` with review prompt) | `codex review [PROMPT]` (first-class subcommand) |
| Resume prior session | `--session <ses_id>` flag on `run` | `codex exec resume <UUID>` subcommand |
| Working directory | `--dir <DIR>` | `-C, --cd <DIR>` |
| Output format | `--format default | json` | `--json` (JSONL events) + `-o, --output-last-message <FILE>` |
| Auto-approve (`--yolo`) | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| Sandbox levels | binary (skip-permissions: on/off) | tri-state: `read-only` / `workspace-write` / `danger-full-access` |
| Reasoning effort (analog of `--variant`) | `--variant <high|max|minimal>` | `-c model_reasoning_effort=high` (TOML config override via `-c`) |
| Session-id format | `ses_[A-Za-z0-9]+` | UUID (per `codex exec resume <SESSION_ID>` help) |
| Config file | `~/.config/opencode/opencode.json` | `~/.codex/config.toml` |
| Config env | `OPENCODE_CONFIG` | `CODEX_HOME` (overrides `~/.codex` location) |
| Binary env | `OPENCODE_BIN` | `CODEX_BIN` (new — same idiom) |
| Branch base for review | (prompt template) | `--base <BRANCH>` (native flag) |
| Common install path | `~/.opencode/bin/opencode` | `~/.codex/bin/codex` (per `codex update`'s default) |

**Mapping decisions:**

- `/codex:review` uses `codex review --base <ref> [PROMPT]` (uses native review subcommand). Falls back to `codex exec` with a review prompt if `--scope working-tree` is selected (codex review doesn't have working-tree-vs-branch flag the same way; we adapt).
- `/codex:run` uses `codex exec [PROMPT]` for foreground; `codex exec --json --output-last-message <FILE>` for background (to capture parseable events + final text).
- `--yolo` translates to `--dangerously-bypass-approvals-and-sandbox`. Default (`--yolo` absent) uses `--sandbox workspace-write` (parity with opencode's "honors permission prompts but allows write access" default).
- `--variant <level>` translates to `-c model_reasoning_effort=<level>`. Free-form pass-through (codex validates).
- Session continuity: stored UUIDs go in the same `<project>/.claudecode-buddy/codex/sessions/<key>-<role>-<model>.session-id` file (analog of opencode's). Resume uses `codex exec resume <UUID>` subcommand.
- Binary auto-discovery: scan `~/.codex/bin/codex` first, then `~/.local/bin/codex`, `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, `/usr/bin/codex`. Same `accessSync(X_OK)` gating.

## Code-sharing strategy

Three options considered:

**(A) Hard fork — copy opencode/scripts/lib/* into codex/scripts/lib/*, modify independently.**
Simple, but doubles maintenance: every bug fix lands in two places. Tests must run on both copies.

**(B) Shared workspace lib — extract `lib/` into a top-level `shared/lib/`, both plugins import.**
Reduces duplication, but Claude Code plugins are designed to be self-contained directories. Cross-plugin imports via relative paths (`../../shared/lib/...`) break if a user installs only one plugin. Marketplace publication assumes plugin dirs are independent.

**(C) Copy + diverge intentionally — same source-tree shape, but each plugin owns its copy; cross-plugin sync is a manual audit.**
This is what we'll do.
Rationale: matches Claude Code's plugin model (self-contained dirs). For files that are 100% CLI-agnostic (`lib/fd-bound.mjs`, `lib/pid-identity.mjs`, `lib/jobs.mjs`, `lib/sessions.mjs`, `lib/trailer.mjs`, `lib/args.mjs`, `lib/scope.mjs` — minus the diff-prompt code), the two copies will be byte-identical. We'll add a workspace-level test (`tests/cross-plugin-sync.test.mjs`) that asserts byte-equality of these files between opencode and codex; this catches drift at CI time.
Files that differ (`lib/invoke.mjs`, `lib/cli-detection.mjs`, `lib/list-models.mjs`, `lib/session-capture.mjs`, `lib/review-dispatch.mjs`, `lib/config.mjs`, `lib/config-detection.mjs`) get codex-specific implementations.

## Phasing

Plan-007 spans the same trajectory the opencode plugin walked across plans 000 → 006, executed as a single plan with 9 phases.
Each phase commits separately so iteration / rollback is granular.
Each phase ports the equivalent opencode source files + tests, adapting to codex CLI surface.
Test count target: ~280 (matching opencode's 284).

### Phase 1 — Plugin skeleton + marketplace registration

**Goal:** establish `plugins/codex/` with manifest, marketplace entry, empty command files, and the cross-plugin-sync test.

**Files:**
- Create: `plugins/codex/.claude-plugin/plugin.json` — version `0.5.1`, name `codex`.
- Create: `plugins/codex/commands/{review,run,setup,status,result,cancel,gate}.md` — stub frontmatter matching opencode's argument-hint shapes (adapted for codex args).
- Create: `plugins/codex/agents/{codex-review,codex-run}.md` — stubs. Plus `codex-rescue.md` as a thin pointer to `codex-review` (alias for backward compat).
- Create: `plugins/codex/skills/codex-cli-runtime/SKILL.md` — stub.
- Create: `plugins/codex/hooks/hooks.json` — three hooks (SessionStart, SessionEnd, Stop), same shape as opencode's.
- Create: `plugins/codex/CHANGELOG.md` — initial `## 0.5.1` entry.
- Create: `plugins/codex/README.md` — initial parity stub pointing at opencode's README for shared concepts.
- Modify: `.claude-plugin/marketplace.json` — add codex plugin entry (version `0.5.1`).
- Modify: `CLAUDE.md` — update Codex references to point at the new plugin (`/codex:review` from claudecode-buddy/codex; `codex:codex-rescue` aliased to `codex-review`).
- Create: `tests/cross-plugin-sync.test.mjs` — asserts byte-equality of shared lib files between opencode + codex.

**Step list:** marketplace test verifies `marketplace.json` lists `codex`. Empty commands return helpful "stub" output. Hooks register but no-op until later phases.

### Phase 2 — `/codex:review` + `codex:codex-review` subagent + read-only path

**Goal:** mirror opencode plan 000. Read-only code review via `codex review` subcommand.

**Files (port from opencode/scripts/lib/):**
- Create: `plugins/codex/scripts/buddy.mjs` — top-level dispatcher.
- Create: `plugins/codex/scripts/lib/args.mjs` — byte-identical port.
- Create: `plugins/codex/scripts/lib/cli-detection.mjs` — codex-specific binary scan paths (`~/.codex/bin/codex`, etc.). Otherwise structurally identical to opencode's.
- Create: `plugins/codex/scripts/lib/config-detection.mjs` — codex config at `~/.codex/config.toml` (TOML, not JSON).
- Create: `plugins/codex/scripts/lib/config.mjs` — TOML read/write for `~/.codex/config.toml` (use a minimal TOML reader since codex config is small).
- Create: `plugins/codex/scripts/lib/invoke.mjs` — uses `codex exec --json` or `codex review --json`. Different output-event shape than opencode; needs codex-specific NDJSON parser.
- Create: `plugins/codex/scripts/lib/scope.mjs` — branch-divergence + diff capture. Add `--no-ext-diff --no-textconv` from day 1 (carry plan-006 H1 fix forward).
- Create: `plugins/codex/scripts/lib/prompt.mjs` — build review prompts for codex (template-style, like opencode's).
- Create: `plugins/codex/scripts/lib/list-models.mjs` — reads `~/.codex/config.toml`, extracts model identifiers.
- Create: `plugins/codex/scripts/lib/trailer.mjs` — byte-identical port (verdict trailer parsing).
- Create: `plugins/codex/scripts/lib/fd-bound.mjs` — byte-identical port.
- Create: `plugins/codex/commands/review.md` — full body: argument-hint `[--scope ...] [--base <ref>] [--model <id>] [--variant <level>] [--style friendly|adversarial] [--session-key ...] [--reset] [--no-session]`. Model picker integration (analog of opencode's). Reads `git diff` output, feeds to `codex review --base <ref>`.
- Create: `plugins/codex/agents/codex-review.md` + `codex-rescue.md` (alias).
- Create: `plugins/codex/commands/setup.md` — wraps `codex --version` + config detection.
- Tests: `tests/codex/{review-cmd,scope,cli-detection,config-detection,config,invoke,list-models,trailer,fd-bound,scope}.test.mjs` (port from opencode/tests).

### Phase 3 — `/codex:run` foreground + background + supervisor + status/result/cancel

**Goal:** mirror opencode plan 001 (write-capable run + background tasks).

**Files (port):**
- `plugins/codex/scripts/lib/supervisor.mjs` — port plan-006 Phase 5a two-layer SIGTERM handler from day 1.
- `plugins/codex/scripts/lib/jobs.mjs` — byte-identical port.
- `plugins/codex/scripts/lib/git.mjs` — port.
- `plugins/codex/commands/run.md` — argument-hint `[--task ...] [--task-file ...] [--model ...] [--variant ...] [--yolo] [--background] [--session-key ...] [--reset] [--no-session]`.
- `plugins/codex/commands/{status,result,cancel}.md`.
- `plugins/codex/agents/codex-run.md`.
- Tests: `tests/codex/{run-cmd,jobs,status-cmd,result-cmd,cancel-cmd,supervisor}.test.mjs`.

### Phase 4 — Session continuity (per `(plan-or-branch, role, model)` tuple)

**Goal:** mirror opencode plan 002. Sessions stored at `<project>/.claudecode-buddy/codex/sessions/<key>-<role>-<model>.session-id` (UUID format). Resume via `codex exec resume <UUID>`.

**Files (port):**
- `plugins/codex/scripts/lib/sessions.mjs` — UUID regex (not `ses_*`); otherwise identical. **Cross-plugin-sync NOTE: NOT byte-identical with opencode/sessions.mjs.** The regex differs.
- `plugins/codex/scripts/lib/session-capture.mjs` — codex emits session-id differently (via stderr log lines or the `--output-last-message` file). Codex-specific parser.
- `plugins/codex/scripts/lib/review-dispatch.mjs` — port the dispatch + session-id resolve logic.
- Update: `commands/{review,run}.md` to wire `--session-key`, `--reset`, `--no-session`.

### Phase 5 — `--style adversarial` + Stop-hook gate

**Goal:** mirror opencode plan 003.

**Files (port):**
- `plugins/codex/scripts/stop-review-gate-hook.mjs` — fail-open ESM ordering from day 1 (carry plan-006 Phase 4 forward).
- `plugins/codex/prompts/adversarial-review.md` — port.
- `plugins/codex/prompts/stop-review-gate.md` — port.
- `plugins/codex/commands/gate.md` — port.
- Update: `review.md` to add `--style` flag.

### Phase 6 — `--variant` flag (codex maps to `-c model_reasoning_effort=...`) + binary auto-discovery

**Goal:** mirror opencode plan 005.

**Notes:**
- `--variant <level>` translates to `-c model_reasoning_effort=<level>` passed to `codex exec` / `codex review`. Free-form pass-through (codex validates).
- `OPENCODE_BUDDY_FORCE_INTERACTIVE` / `OPENCODE_VARIANT` env-var analogs use the `CODEX_BUDDY_*` prefix (new namespace for codex plugin).
- Binary auto-discovery scans `~/.codex/bin/codex` first.

### Phase 7 — RCE + TOCTOU + SIGTERM + pid-identity (carry plan-006 forward)

**Goal:** mirror opencode plan 006 from day 1.

This is the parity baseline — all plan-006 defenses ship in the codex plugin v0.5.1, not deferred to a later codex plan.

**Files (port from opencode v0.5.1):**
- `plugins/codex/scripts/lib/pid-identity.mjs` — byte-identical port (CLI-agnostic).
- `plugins/codex/scripts/lib/fd-bound.mjs` — already in Phase 2.
- Fail-open ESM ordering in `hooks/session-start.mjs` + `session-end.mjs` — already in Phase 1.
- Two-layer SIGTERM in `lib/supervisor.mjs` — already in Phase 3.
- `.catch()` on top-level dispatches — already in Phase 2.
- `git diff --no-ext-diff` in `lib/scope.mjs` — already in Phase 2.
- Test seams: `CODEX_BUDDY_TEST_THROW`, `CODEX_BUDDY_TEST_SLOW_IMPORT_MS`, `CODEX_BUDDY_TEST_PID_NEVER_OURS`.

### Phase 8 — Marketplace + README + CHANGELOG + migration guide

**Goal:** publish-ready.

**Files:**
- `.claude-plugin/marketplace.json` — codex entry already added in Phase 1; verify version + description.
- Workspace `README.md` — add codex plugin to the install instructions.
- `plugins/codex/README.md` — full body (parity with opencode/README.md but codex-specific).
- `plugins/codex/CHANGELOG.md` — `## 0.5.1` entry summarizing the parity baseline.
- `docs/architecture/decisions.md` — add D-014 (codex plugin parity with opencode; code-sharing strategy C; cross-plugin-sync test).
- Migration guide section in workspace README: "Replacing openai-codex with claudecode-buddy/codex" — uninstall openai-codex via `/plugin uninstall codex@openai-codex`; install ours via `/plugin install codex@claudecode-buddy`; same `/codex:*` commands work.

### Phase 9 — 4-way code review + ship

**Goal:** follow workspace policy. Self-Opus + Codex (via codex:codex-rescue from existing openai-codex install) + DeepSeek-V4-Flash + GLM 5.1. All four must approve.

## Test strategy

- **Test parity:** every opencode test gets a codex equivalent under `tests/codex/`. Adapt fixtures for codex CLI output shape (UUID session-ids, codex-specific JSONL events).
- **Cross-plugin-sync test:** `tests/cross-plugin-sync.test.mjs` asserts byte-equality of CLI-agnostic lib files between opencode and codex. Catches drift at CI time.
- **Mocks:** new `tests/codex/fixtures/mock-codex-*.mjs` fixtures matching the opencode fixture catalog (success, malformed, sleep, stubborn-sleep, session-list, etc.).
- **End-to-end:** opt-in via `CODEX_E2E=1` (parity with `OPENCODE_E2E=1`).
- **Test count target:** ~280 codex-side + the existing 287 opencode-side ≈ 570 total.

## Migration story for users

Pre-plan-007:
1. Install openai-codex marketplace: `/plugin marketplace add openai/codex-plugin-cc`.
2. Install codex plugin: `/plugin install codex@openai-codex`.

Post-plan-007:
1. (Optional but recommended) Uninstall openai-codex: `/plugin uninstall codex@openai-codex; /plugin marketplace remove openai-codex`.
2. Install codex from claudecode-buddy: `/plugin install codex@claudecode-buddy` (the marketplace is already registered if the user installed opencode this way).
3. Same `/codex:review`, `/codex:run`, `codex:codex-rescue` (now aliased to `codex-review`) commands work. New: `/codex:gate`, `/codex:status`, `/codex:result`, `/codex:cancel`, `--variant`, `--style adversarial`, session continuity, fd-bound TOCTOU, fail-open hooks, etc.

If both plugins are installed simultaneously, Claude Code's plugin resolver will prefer the most-recently-installed (last-one-wins). The user can verify via `/plugin list` showing both `codex@openai-codex` and `codex@claudecode-buddy`.

## Risks + open questions

- **Codex CLI's session-id format and resume semantics.** Codex stores session files on disk (per `--ephemeral` opt-out flag). The exact session-id capture path needs verification — does `codex exec --json` emit the session UUID in stdout/stderr the way opencode emits `service=session id=ses_<id>` in stderr? Phase 2 implementation must establish this empirically.
- **Codex JSONL event shape.** opencode emits `{type: "text", part: {type: "text", text: "..."}}`. Codex's `--json` shape needs reverse-engineering during Phase 2.
- **Sandbox-level defaults.** Codex's `--sandbox workspace-write` is the closest analog to opencode's "honors permission prompts" default. Codex's `read-only` is review-mode-only. The plugin's `/codex:run` (without `--yolo`) should default to `workspace-write`; `/codex:review` defaults to `read-only`. Confirm during Phase 2.
- **TOML config writes.** Phase 2's `config.mjs` needs to write TOML preserving comments. The opencode equivalent writes JSON which has no comment problem. Either use a TOML library (new npm dep — workspace currently has none, opencode is dep-free) or restrict config writes to non-destructive edits (append-only or specific-key replacement).
- **Backward compatibility for `codex:codex-rescue`.** The CLAUDE.md references this name extensively. The plan aliases `codex-rescue.md` to `codex-review` so existing references continue to resolve. After publish, gradually migrate CLAUDE.md text + reviewer-dispatch prompts to `codex-review` for terminology consistency with `opencode:opencode-review`.

## Plan Review (4-way — to be filled in before implementation)

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-review (Opus 4.7) | TBD |
| 2 | Codex via `codex:codex-rescue` | TBD |
| 3 | DeepSeek V4 Pro via opencode bash | TBD |
| 4 | GLM 5.1 via opencode bash | TBD |

## Code Review (4-way — to be filled in after implementation)

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-review (Opus 4.7) | TBD |
| 2 | Codex | TBD |
| 3 | DeepSeek V4 Flash | TBD |
| 4 | GLM 5.1 | TBD |

## Post-execution report

(To be filled in before shipping.)

| Phase | Status | Commit |
|---|---|---|
| 1 — Plugin skeleton + marketplace + cross-sync test | TBD | — |
| 2 — `/codex:review` + read-only path | TBD | — |
| 3 — `/codex:run` + background + supervisor | TBD | — |
| 4 — Session continuity | TBD | — |
| 5 — `--style adversarial` + Stop-hook gate | TBD | — |
| 6 — `--variant` + binary auto-discovery | TBD | — |
| 7 — RCE + TOCTOU + SIGTERM (plan-006 carryover) | TBD | — |
| 8 — Marketplace + docs + migration guide | TBD | — |
| 9 — 4-way code review + ship | TBD | — |
