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

**(C) Copy + diverge intentionally — same source-tree shape, but each plugin owns its copy.**
This is what we'll do. Matches Claude Code's plugin model (self-contained dirs).

### Byte-identical file set (revised after round-1 review R1)

Only 3 files are truly CLI-agnostic and survive byte-equality between opencode and the codex plugin:

| File | Byte-identical? | Why |
|---|---|---|
| `lib/fd-bound.mjs` | ✅ Yes | Pure POSIX fd-open wrapper; no plugin-specific strings |
| `lib/pid-identity.mjs` | ✅ Yes | The `"buddy-supervisor"` cmdline prefix is CLI-agnostic |
| `lib/args.mjs` | ✅ Yes | Pure shell-style splitter |
| `lib/jobs.mjs` | ❌ No | `jobsDir()` hardcodes `".claudecode-buddy/opencode/jobs"` path — codex copy needs `"codex"` |
| `lib/sessions.mjs` | ❌ No | (a) `SESSION_ID_RE` is `ses_*` vs UUID for codex; (b) path hardcodes `"opencode"` |
| `lib/trailer.mjs` | ❌ No | User-visible error message says `"in opencode output"` — codex copy says `"in codex output"` |
| `lib/scope.mjs` | ❌ No | Comments reference `/opencode:review` — minor, but enough to break byte-equality |

The 4 NOT-byte-identical files use the same source-tree shape and structurally identical bodies; the cross-plugin-sync test (Phase 8) asserts byte-equality only on the 3 truly identical files. The other 4 are maintained via manual sync — when a logic change lands in opencode's `lib/`, it must be hand-ported to codex's `lib/` in the same PR (and vice versa).

A future maintenance plan may revisit this by extracting a `PLUGIN_ID` constant from each non-identical file so they become byte-identical (GLM round-1 review suggestion). For plan-007 the 3-file scope is the pragmatic baseline.

### Files with codex-specific implementations (always divergent)

- `lib/invoke.mjs` — codex uses `codex exec --json`; opencode uses `opencode run --format json`. Different event-stream parser per Phase 1.5 gate findings.
- `lib/cli-detection.mjs` — different `WELL_KNOWN_PATHS` (codex at `~/.codex/bin/`).
- `lib/list-models.mjs` — codex reads `~/.codex/config.toml` (TOML); opencode reads `~/.config/opencode/opencode.json` (JSON).
- `lib/session-capture.mjs` — codex emits session-id differently per Phase 1.5 gate R9-b.
- `lib/review-dispatch.mjs` — codex uses `codex exec resume <UUID>` (subcommand) vs opencode's `--session <id>` (flag) per Phase 1.5 gate R9-c.
- `lib/config.mjs` — codex is TOML-read-only (no writes from plugin to avoid TOML-comment-preservation complexity).
- `lib/config-detection.mjs` — different config path + env var (`CODEX_HOME`).
- `lib/supervisor.mjs` — different child-spawn argv (`codex exec ...` not `opencode run ...`).
- `lib/prompt.mjs` — codex-specific review prompt templates.

## Phasing

Plan-007 spans the same trajectory the opencode plugin walked across plans 000 → 006, executed as a single plan with 9 phases.
Each phase commits separately so iteration / rollback is granular.
Each phase ports the equivalent opencode source files + tests, adapting to codex CLI surface.
Test count target: ~280 (matching opencode's 284).

### Phase 1 — Plugin skeleton + manifests + hook scripts

**Goal (revised after R12):** establish `plugins/codex/` with manifest, marketplace entry, command + agent + skill skeletons, AND the actual hook scripts with fail-open ESM ordering from day 1. The cross-plugin-sync test creation moves to Phase 8 (per R3).

**Files (revised after R5, R6, R12):**
- Create: `plugins/codex/.claude-plugin/plugin.json` — version `0.5.1`, name `codex`.
- Create: `plugins/codex/commands/{review,run,setup,status,result,cancel,gate,rescue}.md` — stub frontmatter. **R5**: `rescue.md` is the new addition to preserve `/codex:rescue` parity with openai-codex.
- Create: `plugins/codex/agents/codex-review.md` — full body (will be populated in Phase 2; stub for Phase 1).
- Create: `plugins/codex/agents/codex-run.md` — stub (body lands in Phase 3).
- Create: `plugins/codex/agents/codex-rescue.md` — **R6**: a literal copy of `codex-review.md`'s body with the file-level `name: codex-rescue` field changed. Same content, different agent name. Maintenance: tested for byte-equality-except-name-field in Phase 8.
- Create: `plugins/codex/skills/codex-cli-runtime/SKILL.md` — stub.
- Create: `plugins/codex/hooks/hooks.json` — three hooks (SessionStart, SessionEnd, Stop), same timeouts as opencode's (5s / 5s / 1500s).
- Create: `plugins/codex/hooks/session-start.mjs` — **R12**: full body with fail-open ESM ordering from day 1 (static `node:*` → register `uncaughtException` + `unhandledRejection` → dynamic `await import("../scripts/lib/jobs.mjs")`). Includes the `OPENCODE_BUDDY_TEST_THROW=hookLoad`-equivalent (`CODEX_BUDDY_TEST_THROW=hookLoad`) seam.
- Create: `plugins/codex/hooks/session-end.mjs` — same pattern.
- Create: `plugins/codex/CHANGELOG.md` — initial `## 0.5.1` entry.
- Create: `plugins/codex/README.md` — initial parity stub.
- Modify: `.claude-plugin/marketplace.json` — add codex plugin entry (version `0.5.1`).
- Modify: `CLAUDE.md` — update Codex references to point at the new plugin.

**Deferred to Phase 8 (per R3):**
- `tests/cross-plugin-sync.test.mjs` (test creation moves to Phase 8 after all lib files exist).

**Note:** session-start.mjs + session-end.mjs land here but their orphan-detection logic (which uses pidIsOurSupervisor) requires Phase 3's `lib/jobs.mjs` + `lib/pid-identity.mjs`. Phase 1 ships the scripts with the dynamic-import calls; they'll error gracefully (fail-open) until Phase 3 creates the imported modules. The session-start orphan-detection branch is gated behind `if (list.ok)` so an empty-job-list (Phase 1 state) is silent.

### Phase 1.5 — Empirical codex CLI gate (NEW per R9)

**Goal:** verify the codex CLI assumptions Phases 2-7 depend on, BEFORE building on them. Land empirical findings inline in this plan; if any assumption fails, **revise the plan before Phase 2**.

**Verification commands (each captures stdout + stderr + exit code; results appended to this plan section):**

1. **`codex exec --json "echo hi"`** — verify JSONL event shape. Expected: NDJSON events with parseable assistant-text. Capture: a representative event sequence (step_start, text, step_finish or analog). If shape is fundamentally different from opencode's, document the parser delta in Phase 2.

2. **`codex exec --json "test"` + grep for UUID** in stdout, stderr, and the file written by `--output-last-message <path>`. **R9-(b):** identify which channel emits the session UUID for capture. If NONE, Phase 4 (session continuity) is infeasible and must be descoped to "no session continuity for codex; users must use `--ephemeral` or accept fresh sessions."

3. **`codex exec resume <UUID> "follow-up prompt"`** — verify that resume accepts a positional prompt argument (not just interactive). **R9-(c):** if resume is interactive-only, Phase 4's design changes fundamentally (can't send a follow-up prompt to a resumed session non-interactively → session continuity becomes "resume the conversation visually" only, not useful for the dispatch path).

4. **`codex exec --sandbox workspace-write "echo > test.txt"`** — does it prompt before writing? **R9-(d) + R11:** if `workspace-write` is silent-allow (no per-write prompt), the default `/codex:run` sandbox becomes `read-only` and `--yolo` becomes the only path to writes (mapping to `danger-full-access`). Document the decision in CHANGELOG.

5. **Install both openai-codex and a stub claudecode-buddy/codex plugin simultaneously; run `/codex:setup`.** Observe which plugin's command runs. **R7:** if Claude Code errors on collision OR ignores the newer plugin, migration guide is "uninstall openai-codex FIRST." If it's last-installed-wins, the migration is gentler. Either way, the conservative wording stays as the canonical instruction.

**Output format:** each verification gets a subsection in this plan with: command run, stdout/stderr/exit-code summary, plan-impact verdict (PASS / REVISE / DESCOPE).

**Decision point:** if ALL gates PASS, proceed to Phase 2. If 1+ fails with REVISE, update the affected phases in this plan and re-dispatch the 4-way plan review on the revised plan. If a gate fails with DESCOPE, narrow scope (e.g., drop Phase 4 session continuity) and re-dispatch reviewers on the narrowed plan.

### Phase 2 — `/codex:review` + `codex:codex-review` subagent + read-only path

**Goal:** mirror opencode plan 000. Read-only code review.

**Depends on:** Phase 1 (skeletons) + **Phase 1.5 (CLI gate verified)**.

**Files (revised after R2):**
- Create: `plugins/codex/scripts/buddy.mjs` — top-level dispatcher.
- Create: `plugins/codex/scripts/lib/args.mjs` — **byte-identical** to opencode's (per R1; one of the 3 confirmed CLI-agnostic files).
- Create: `plugins/codex/scripts/lib/cli-detection.mjs` — codex-specific binary scan paths (`~/.codex/bin/codex`, `~/.local/bin/codex`, `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, `/usr/bin/codex`). Structurally identical to opencode's; differs only in `WELL_KNOWN_PATHS` array.
- Create: `plugins/codex/scripts/lib/config-detection.mjs` — codex config at `~/.codex/config.toml`; respects `CODEX_HOME` env override.
- Create: `plugins/codex/scripts/lib/config.mjs` — TOML read for `~/.codex/config.toml`. **Limited surface**: only reads (no writes from the plugin); avoids TOML-write comment-preservation complexity. Use a minimal regex-based TOML reader for the small set of keys the plugin actually needs (`model`, `model_reasoning_effort`); full TOML parsing is unnecessary.
- Create: `plugins/codex/scripts/lib/invoke.mjs` — **R2**: uses `codex exec --json` for ALL parseable runs (review + non-review). The `codex review` subcommand is NOT used by the plugin's invoke path — its `--json` mode doesn't exist per round-1 finding. For review, the plugin sends the diff + review-prompt-template through `codex exec --json` (treating codex as a generic exec target with a curated prompt). Output parsing follows the empirical event shape from Phase 1.5 gate (1).
- Create: `plugins/codex/scripts/lib/scope.mjs` — branch-divergence + diff capture. Adds `--no-ext-diff --no-textconv` from day 1 (carry plan-006 H1 fix forward). **NOT byte-identical** to opencode's (R1 — contains `"opencode"`-flavored comments).
- Create: `plugins/codex/scripts/lib/prompt.mjs` — build review prompt templates for codex.
- Create: `plugins/codex/scripts/lib/list-models.mjs` — parses `~/.codex/config.toml` for available model identifiers.
- Create: `plugins/codex/scripts/lib/trailer.mjs` — verdict trailer parsing. **NOT byte-identical** to opencode's (R1 — error message refers to "opencode output"); the codex copy says "in codex output." Otherwise identical body.
- Create: `plugins/codex/scripts/lib/fd-bound.mjs` — **byte-identical** to opencode's (R1).
- Create (full body): `plugins/codex/commands/review.md` — argument-hint `[--scope ...] [--base <ref>] [--model <id>] [--variant <level>] [--style friendly|adversarial] [--session-key ...] [--reset] [--no-session]`. Model picker integration. Reads `git diff` output, feeds to `codex exec --json` with the review prompt template.
- Create (full body): `plugins/codex/agents/codex-review.md` + `codex-rescue.md` (literal copy per R6).
- Create (full body): `plugins/codex/commands/setup.md`.
- Tests: `tests/codex/{review-cmd,scope,cli-detection,config-detection,config,invoke,list-models,trailer,fd-bound}.test.mjs` (port from opencode/tests/, adapt fixtures for codex's empirical event shape).

### Phase 3 — `/codex:run` foreground + background + supervisor + status/result/cancel

**Goal:** mirror opencode plan 001 (write-capable run + background tasks).

**Depends on:** Phase 2 (lib/invoke.mjs, the dispatcher shape).

**Files:**
- `plugins/codex/scripts/lib/supervisor.mjs` — ports plan-006 Phase 5a two-layer SIGTERM handler from day 1. **NOT byte-identical** to opencode's — codex-specific child-spawn argv (`codex exec` not `opencode run`) and session-id-capture-from-stderr logic.
- `plugins/codex/scripts/lib/jobs.mjs` — **NOT byte-identical** to opencode's (R1: `jobsDir()` hardcodes `"opencode"` path; codex copy hardcodes `"codex"`). Otherwise identical body.
- `plugins/codex/scripts/lib/git.mjs` — port. May be byte-identical (CLI-agnostic git wrapper) — verify in Phase 8 sync test.
- `plugins/codex/commands/run.md` — full body.
- `plugins/codex/commands/{status,result,cancel}.md` — full bodies.
- `plugins/codex/agents/codex-run.md` — full body.
- **R11**: per Phase 1.5 sandbox verification, the `/codex:run` default sandbox is decided here. If `workspace-write` is silent-allow, default is `read-only` and `--yolo` is required for writes (mapping to `danger-full-access`). If `workspace-write` prompts per write, default is `workspace-write` (parity with opencode).
- Tests: `tests/codex/{run-cmd,jobs,status-cmd,result-cmd,cancel-cmd,supervisor}.test.mjs`.

### Phase 4 — Session continuity (per `(plan-or-branch, role, model)` tuple)

**Goal:** mirror opencode plan 002. Sessions stored at `<project>/.claudecode-buddy/codex/sessions/<key>-<role>-<model>.session-id` (UUID format).

**Depends on:** Phase 2 (invoke.mjs event-shape parser) + Phase 3 (jobs.mjs + lock primitive in sessions.mjs).

**Conditional execution (per Phase 1.5 gate R9-b/c):** if Phase 1.5 confirms that (a) codex emits the session UUID where we can capture it AND (b) `codex exec resume <UUID> [PROMPT]` accepts a positional prompt, Phase 4 proceeds as planned. If EITHER fails:
- (a)-fail: descope Phase 4 entirely — session continuity is unavailable for codex; users get fresh sessions every dispatch. Add a `## Known limitations` entry in CHANGELOG.
- (b)-fail: Phase 4 lands `sessions.mjs` storage but `review-dispatch.mjs` doesn't actually resume; the stored UUID is informational only.

**Files (port; assumes happy path):**
- `plugins/codex/scripts/lib/sessions.mjs` — **NOT byte-identical** to opencode's (R1: `SESSION_ID_RE` differs — UUID vs `ses_*` regex; path hardcodes `"codex"`). Otherwise identical body.
- `plugins/codex/scripts/lib/session-capture.mjs` — codex-specific session-id extraction. Implementation depends on Phase 1.5 gate R9-b finding (stderr / stdout / output-last-message file).
- `plugins/codex/scripts/lib/review-dispatch.mjs` — port the dispatch + session-id resolve logic. Adapts the resume-invocation shape (`codex exec resume <UUID> [PROMPT]` if R9-c passes).
- Update: `commands/{review,run}.md` to wire `--session-key`, `--reset`, `--no-session`.

### Phase 5 — `--style adversarial` + Stop-hook gate

**Goal:** mirror opencode plan 003.

**Depends on:** Phase 2 (invoke.mjs) + Phase 4 (review-dispatch.mjs, for the gate's review invocation).

**Files (port):**
- `plugins/codex/scripts/stop-review-gate-hook.mjs` — fail-open ESM ordering from day 1 (carry plan-006 Phase 4 forward).
- `plugins/codex/prompts/adversarial-review.md` — port.
- `plugins/codex/prompts/stop-review-gate.md` — port.
- `plugins/codex/commands/gate.md` — port.
- Update: `review.md` to add `--style` flag.

### Phase 6 — `--variant` flag + binary auto-discovery

**Goal:** mirror opencode plan 005.

**Depends on:** Phase 2 (invoke.mjs flag-forwarding shape) + Phase 1 (cli-detection scaffolding).

**Notes:**
- `--variant <level>` translates to `-c model_reasoning_effort=<level>` passed to `codex exec`. Free-form pass-through (codex validates the value; plugin doesn't).
- Test seams use `CODEX_BUDDY_*` prefix (parity-named with `OPENCODE_BUDDY_*`).
- Binary auto-discovery scans `~/.codex/bin/codex` first (already in Phase 2's cli-detection.mjs); Phase 6 just adds the `--variant` flag layer.

### Phase 7 — Verification audit (NEW per R4)

**Goal (revised after R4):** **Verification phase, not file-creation.** Confirms every plan-006 defense from opencode v0.5.1 is in place in the codex plugin. No new files created.

**Verification checklist:**

- [ ] `git diff --no-ext-diff --no-textconv` on all `scope.mjs` + `buddy.mjs:diffSummary` call sites (carried in Phase 2). Grep + manual review.
- [ ] `lib/fd-bound.mjs` with `nofollow` option carried from Phase 2.
- [ ] `lib/pid-identity.mjs` with injectable `{platform, cmdlineReader, isAlive}` (carried in Phase 3 — `pid-identity.mjs` is byte-identical to opencode's per R1).
- [ ] Session-start.mjs + session-end.mjs use fail-open ESM ordering (carried from Phase 1).
- [ ] Stop-review-gate-hook.mjs uses fail-open ESM ordering (carried from Phase 5).
- [ ] supervisor.mjs has two-layer SIGTERM handler with `dynamicImportsReady` flag, inline-fallback branch, and `let child = null` module-scope state (carried in Phase 3).
- [ ] `.catch()` on top-level async dispatches in `buddy.mjs` (carried in Phase 2).
- [ ] Test seams: `CODEX_BUDDY_TEST_THROW={runReview,runRun,runPrompt,hookLoad}`, `CODEX_BUDDY_TEST_SLOW_IMPORT_MS`, `CODEX_BUDDY_TEST_PID_NEVER_OURS`. Grep for env-var checks.
- [ ] `runCancel` uses `pidIsOurSupervisor` (not bare isAlive); orphan detection in session-start.mjs uses the same helper.
- [ ] No "macOS best-effort PID match" warning in `runCancel` (carried from plan-006 round-1 code-review fix at commit `0dec4f4`).
- [ ] `parseRunArgs` calls `isUnderAllowedDir(taskFile)` BEFORE `readTaskFileFdBound` (carried from same commit).
- [ ] `--prompt-file` symlink-target rejection works (Phase 2 test).
- [ ] `--task-file` symlink-target rejection works (Phase 3 test).
- [ ] cancel-of-live-supervisor RELEASES the session lock (Phase 3 test).
- [ ] Pre-import SIGTERM-releases-lock test via `CODEX_BUDDY_TEST_SLOW_IMPORT_MS` (Phase 3 test).
- [ ] PID-reuse-defense test via `CODEX_BUDDY_TEST_PID_NEVER_OURS` (Phase 3 test).

Phase 7 produces no new files; it produces a **verification-results.md** sub-document recording the audit + a checklist commit confirming each item.

### Phase 8 — Marketplace + cross-plugin-sync test + README + CHANGELOG + migration guide

**Goal (revised after R3):** publish-ready + the cross-plugin-sync test lands here after all lib files exist.

**Files:**
- Modify: `.claude-plugin/marketplace.json` — codex entry already added in Phase 1; verify version + description.
- Modify: Workspace `README.md` — add codex plugin to the install instructions.
- Create (full body): `plugins/codex/README.md` — parity with opencode/README.md but codex-specific.
- Update: `plugins/codex/CHANGELOG.md` — `## 0.5.1` entry summarizing the parity baseline. **Include the sandbox-mapping decision** (per R11) and any descoped scope from Phase 1.5 gate failures.
- Create: `docs/architecture/decisions.md` entry D-014 (codex plugin parity; code-sharing strategy C; cross-plugin-sync test scope).
- Create: `tests/cross-plugin-sync.test.mjs` — **R1**: asserts byte-equality of the 3 truly identical files only (`fd-bound.mjs`, `pid-identity.mjs`, `args.mjs`). Also asserts that `agents/codex-rescue.md` is byte-identical to `agents/codex-review.md` except for the `name:` frontmatter field (R6 alias mechanism).
- Migration guide section in workspace README: **R7 + R8** — "**Replacing openai-codex with claudecode-buddy/codex**":
  1. (Conservative — uninstall-first): `/plugin uninstall codex@openai-codex` (avoids namespace collision regardless of Claude Code's resolver behavior).
  2. (Optional cleanup): `/plugin marketplace remove openai-codex`.
  3. (R8): "openai-codex's persisted background-job and session state DO NOT migrate. They remain in their original data dir (`~/.claude/plugins/data/codex-openai-codex/` if present). To recover prior background-job output, run `/codex:result <id>` against the OLD plugin BEFORE uninstalling."
  4. Install: `/plugin install codex@claudecode-buddy` (the marketplace is already registered if the user installed opencode this way).
  5. (Restart) `/plugin marketplace update claudecode-buddy && /reload-plugins`.
  6. Same `/codex:review`, `/codex:run`, `/codex:rescue`, `codex:codex-rescue` (aliased to `codex-review`) commands work. New: `/codex:gate`, `/codex:status`, `/codex:result`, `/codex:cancel`, `--variant`, `--style adversarial`, session continuity (if Phase 1.5 gate R9-b/c passed), fd-bound TOCTOU, fail-open hooks, etc.

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

## Plan Review (4-way)

### Round 1 (HEAD `ebca696`) — 4-of-4 ⚠️ needs-attention

| # | Reviewer | Verdict |
|---|---|---|
| 1 | Self-Opus 4.7 | ⚠️ needs-attention |
| 2 | Codex via `codex:codex-rescue` | ⚠️ needs-attention (11 \[OPEN\]) |
| 3 | DeepSeek V4 Pro via bash | ⚠️ needs-attention (4 \[OPEN\] blockers + 6 advisories) |
| 4 | GLM 5.1 via bash | ⚠️ needs-attention (7 \[OPEN\] items) |

### Consolidated round-1 \[OPEN\] blockers (dedup across reviewers)

| # | Source(s) | Issue | Resolution |
|---|---|---|---|
| R1 | All 4 | **Byte-equality claim wrong for 4 of 7 files.** `jobs.mjs`, `sessions.mjs`, `trailer.mjs`, `scope.mjs` hardcode `"opencode"` in paths/strings. Cross-plugin-sync test would fail on first run. | Restrict byte-equality assertions to truly CLI-agnostic files: `fd-bound.mjs`, `pid-identity.mjs`, `args.mjs`. For the other 4, accept divergence (Strategy C inherent trade-off) and add behavioral parity tests separately if needed. GLM's PLUGIN_ID-constant-extraction proposal is elegant but invasive (touches existing opencode files); defer to a future maintenance plan. |
| R2 | Codex | **`codex review --json` doesn't exist** — only `codex exec --json` does. Plan's invoke.mjs design used `codex review --json` for the review path, which won't work. | Use `codex exec --json` for all parseable runs (review + non-review). The `codex review` subcommand stays for human-readable output via the `--output-last-message <FILE>` mechanism, but the plugin's invoke path uses `codex exec [--json]`. |
| R3 | Codex + DeepSeek-Pro | **Cross-plugin-sync test created in Phase 1 before its assertion targets exist in Phase 2+.** Ordering gap — the test would fail or trivially pass. | Move test creation to **Phase 8** (integration/docs phase) after all lib files exist. Phase 1 still creates the manifests + skeletons but defers the cross-sync assertion. |
| R4 | Codex + GLM + Self-Opus | **Phase 7 duplicates file creation from Phase 2/3.** Lists `pid-identity.mjs` + `fd-bound.mjs` as "Files (port)" but those land in Phase 2. Phase 7 also claims fail-open ESM ordering is "already in Phase 1" but Phase 1 doesn't actually create the hook scripts. | Restructure **Phase 7 as a verification-audit phase**, not new file creation. Phase 7 confirms (with a checklist + targeted tests) that all opencode plan-006 defenses are present. Phase 1's "hooks.json" sub-step is expanded to also create the actual hook scripts (`session-start.mjs`, `session-end.mjs`) with fail-open ordering from day 1. |
| R5 | Codex | **`/codex:rescue` slash command from openai-codex missed.** Replacement plugin omits it; users who relied on `/codex:rescue` get a regression. | Add `commands/rescue.md` to Phase 1. Functionally identical to `codex-rescue` subagent dispatch via slash-command surface. |
| R6 | Codex + GLM + DeepSeek-Pro | **`codex-rescue.md` aliasing mechanism speculative.** Claude Code has no frontmatter-pointer; the file is loaded as a standalone agent definition. | Spell out concrete mechanism: `agents/codex-rescue.md` is a **literal copy** of `agents/codex-review.md` with the file-level `name: codex-rescue` field changed. Same body, different name. Cross-plugin-sync test (Phase 8) asserts the two files are byte-identical except for the name field. Maintenance burden is minimal — both files are short. |
| R7 | Codex + GLM + DeepSeek-Pro | **Namespace collision resolution between two plugins unverified.** Plan asserted "last-installed wins" without proof. If Claude Code errors on collision instead, migration UX is broken. | Plan moves to a **conservative migration policy**: require uninstall-first ("Step 1: `/plugin uninstall codex@openai-codex`; Step 2: `/plugin install codex@claudecode-buddy`"). Add a Phase 1.5 verification step that empirically tests Claude Code's behavior with both plugins installed — if it's "last-installed wins", we soften the migration guide; if it errors, the conservative wording stays. |
| R8 | Codex | **Old plugin state (jobs/sessions under openai-codex's data dir) not addressed.** Migration story doesn't say what happens to those records. | Add to migration guide: "openai-codex's persisted jobs and sessions DO NOT migrate to the claudecode-buddy/codex plugin. They remain under their original data dir (`~/.claude/plugins/data/codex-openai-codex/` if present); the new plugin starts with a fresh state under `<project>/.claudecode-buddy/codex/`. Users who need to recover prior background-job output should `/opencode:result <id>` against the OLD plugin BEFORE uninstalling, or manually inspect that data dir." |
| R9 | Codex + GLM + DeepSeek-Pro | **Codex CLI assumptions unverified** — `codex exec --json` event shape, session UUID capture path, `codex exec resume <UUID> [PROMPT]` semantics, sandbox semantic equivalence. Phase 2-5 build on these assumptions; if any fail, cascading rework. | **Add Phase 1.5: Empirical CLI gate** before Phase 2. Run targeted commands, capture stdout/stderr, parse output shape, document findings inline in the plan. **If any assumption fails, the plan is REVISED before Phase 2 starts.** Specific gates: (a) `codex exec --json "echo hi"` emits parseable JSONL with assistant-text events. (b) Session UUID appears in stdout, stderr, or `--output-last-message` file. (c) `codex exec resume <UUID> "new prompt"` accepts a positional prompt for the resumed session. (d) `--sandbox workspace-write` either prompts per write (parity with opencode default) or doesn't (semantic gap, needs `/codex:run` to require `--yolo` for writes). |
| R10 | DeepSeek-Pro | **Phase 4 depends on Phase 3 but plan doesn't state it.** Phase 4's `review-dispatch.mjs` uses `jobs.mjs` + supervisor patterns from Phase 3. | Add explicit "Depends on: Phase 3" note to Phase 4. Same for inter-phase dependencies across all phases. |
| R11 | GLM + DeepSeek-Pro | **Sandbox semantic gap.** opencode's "honors permission prompts" default is more conservative than codex's `workspace-write` (which may be silent-allow). | Phase 1.5 verifies. If `workspace-write` is silent-allow, **`/codex:run` default becomes `--sandbox read-only`** and users must pass `--yolo` (→ `danger-full-access`) for any write capability. This restores the "user must consent before writes" property. Document in CHANGELOG. |
| R12 | Self-Opus | **Phase 1 missing actual hook scripts.** Plan creates `hooks/hooks.json` (manifest) but not the script files. Phase 7's "fail-open already in Phase 1" claim is wrong. | Phase 1 creates `hooks/session-start.mjs` + `hooks/session-end.mjs` (ports from opencode/hooks/) with fail-open ESM ordering from day 1 (carrying plan-006 Phase 4 forward). Stop-hook script lands in Phase 5 with the gate command. |

### Round 2 (post-revision) verdicts — TBD after revision commit

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
| 1 — Plugin skeleton + manifests + hook scripts | TBD | — |
| 1.5 — Empirical codex CLI gate (PASS / REVISE / DESCOPE) | TBD | — |
| 2 — `/codex:review` + read-only path | TBD | — |
| 3 — `/codex:run` + background + supervisor | TBD | — |
| 4 — Session continuity (conditional on Phase 1.5 gate) | TBD | — |
| 5 — `--style adversarial` + Stop-hook gate | TBD | — |
| 6 — `--variant` + binary auto-discovery layer | TBD | — |
| 7 — **Verification audit** (no new files; checklist commit) | TBD | — |
| 8 — Marketplace + cross-plugin-sync test + docs + migration | TBD | — |
| 9 — 4-way code review + ship | TBD | — |
| Plan review round 1 | ⚠️ 4-of-4 needs-attention (12 blockers consolidated) | `ebca696` |
| Plan review round 2 (post-revision) | TBD | this commit |
