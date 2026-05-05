# Architecture decisions

This file records cross-cutting architectural decisions for the workspace.
Plans introducing new decisions update this file as part of the plan's "Ship" step (`docs/development-workflow.md` Step 6).

Each decision is brief: *what* was decided, *why*, and *which plan introduced it*.
Defer implementation detail to the plan/spec; this file is the index.

---

## D-001 — Plugin layout mirrors the reference codex plugin

**Decided in:** plan 000 (`docs/plans/000-opencode-plugin-v1-scaffold.md`).
**Spec:** `docs/specs/opencode-plugin.md`.

Plugins under `plugins/<name>/` follow the OpenAI codex plugin layout: `.claude-plugin/plugin.json` manifest, `commands/` (user-facing slash commands), `agents/` (programmatic subagents), `skills/` (internal helper contracts with `user-invocable: false`), `scripts/` (Node runners + `lib/` utilities), `schemas/` (JSON schemas).

Why: zero cognitive overhead for users familiar with the codex plugin; the workspace's purpose is to ship Claude-Code-wraps-an-external-CLI plugins and the codex plugin is the canonical example to mirror.

## D-002 — One Node companion script per plugin, with `lib/` utilities

**Decided in:** plan 000.
**Naming superseded by D-009 (plan 001).** The structural decision (one companion file + `lib/` split + no external deps) stands; only the file name changed.

Each plugin's runtime lives in a single Node ESM file (originally `scripts/<plugin>-companion.mjs`, renamed to `scripts/buddy.mjs` per D-009) with subcommand routing. Pure utilities split into `scripts/lib/*.mjs`. No external runtime dependencies (Node ≥ 18.18 built-ins only) for v1.

Why: keeps the runtime auditable in one file, mirrors codex's `codex-companion.mjs` pattern, and avoids the lockfile / dependency-management story until a real need surfaces.

## D-003 — Subagent naming uses redundant prefix

**Decided in:** plan 000.

Subagents are named `<plugin>:<plugin>-<role>` (e.g., `opencode:opencode-review`), mirroring codex's `codex:codex-rescue`. The redundant prefix in the second segment is intentional — it makes the agent identifier readable in isolation (`opencode-review`) without losing the namespacing.

Why: consistency with the reference codex plugin makes orchestrator code (`Agent({subagent_type: "..."})`) interchangeable in shape across plugins.

## D-004 — Three-model code-review consensus, two-model plan-review consensus

**Decided in:** plan 000 (workflow update committed mid-implementation).

- **Plan reviews** use *two* independent reviewers: Codex (gpt-5.5) and opencode pinned to `deepseek/deepseek-v4-pro`.
- **Code reviews** use *three* independent reviewers: Codex (gpt-5.5), opencode pinned to `deepseek/deepseek-v4-flash`, and opencode pinned to `volcengine-plan/glm-5.1`.

Models are pinned explicitly (not "whatever the user has set as default") so the consensus doesn't drift over time.

Why: more rigor for code (which lands in production) than plans (which are revisable). Pinning models keeps reviews reproducible and prevents config drift from invalidating prior verdicts.

## D-005 — Hybrid review output convention (Markdown + fenced JSON trailer)

**Decided in:** plan 000.
**Spec:** `docs/specs/opencode-plugin.md` → "Hybrid output convention" and "Why a minimal trailer schema?".

Reviews emit human-readable Markdown findings followed by a single fenced ```json``` trailer block: `{"verdict": "approve" | "needs-attention", "blockers": [string]}`. The trailer is the smallest schema that satisfies the dual-review gate's "blockers vs no blockers" routing requirement and works reliably across the heterogeneous models opencode can run.

Why: rich nested JSON schemas (codex-style) require frontier models to honor reliably; the workspace's review pipeline must work with whatever model the user has configured under opencode.

## D-006 — HANDOFF.md is not a recurring per-session convention

**Decided in:** plan 000.

The bootstrap-session HANDOFF.md was retired at the end of plan 000. Future inter-session handoff is covered generically by `docs/development-workflow.md` → "Session Handoff Rules" plus per-plan post-execution reports.

Why: a single recurring HANDOFF.md becomes stale fast and competes with the per-plan post-execution report for the "what to pick up next" role. The latter is more discoverable (lives next to the plan) and more accurate (written immediately after the work).

## D-007 — Handwritten JSON Schema validators in v1, no `ajv` dependency

**Decided in:** plan 000.

Schemas under `schemas/` are documentation-only references. Runtime validation uses small handwritten validators in `scripts/lib/`. No `ajv` (or other validator) dependency in v1.

Why: the v1 trailer schema is tiny (one enum field + a string array); a dependency would add ~500 KB of `node_modules` for a 20-line validator and force the workspace into lockfile management.

## D-008 — Workspace-shared plugin runtime state directory

**Decided in:** plan 001 (`docs/plans/001-opencode-run-and-background.md`).
**Spec:** `docs/specs/opencode-plugin.md` → "Background-job state and lifecycle".

Plugin runtime state (background-job records, transient caches, etc.) lives at `<project>/.claudecode-buddy/<plugin-name>/...`. The top-level `.claudecode-buddy/` directory is the workspace convention; each plugin gets a subdirectory under it.

Why: future plugins (e.g., a hypothetical `aider` or `cursor-cli` plugin) share the same state-dir convention, enabling cross-plugin features later (e.g., a workspace-level `/buddy:status` aggregating jobs across plugins) without migration. Per-plugin subdirs keep each plugin's state isolated until such a feature is built.

`.claudecode-buddy/` is always gitignored.

## D-009 — Plugin runtime entry point is `scripts/buddy.mjs`

**Decided in:** plan 001.
**Spec:** `docs/specs/opencode-plugin.md` → "Companion runtime entry point: buddy.mjs".

Each plugin's Node companion script is named `scripts/buddy.mjs` (not `<plugin>-companion.mjs`).

Why: aligns with the workspace name (`claudecode-buddy`) and the state-dir convention (`.claudecode-buddy/`). Reduces visual collision with codex's `codex-companion.mjs`. Generic file name + parent directory (`plugins/<name>/scripts/buddy.mjs`) is cleanly disambiguated by the parent dir in any reasonable editor navigation context.

Plan 001 renames the existing `plugins/opencode/scripts/opencode-companion.mjs` to `plugins/opencode/scripts/buddy.mjs` and updates all references (slash commands, subagents, skill, tests, docs). All future plugins adopt the same name from the start.

## D-010 — Review session continuity is per-(plan-or-branch, role, model)

**Decided in:** plan 002 (`docs/plans/002-review-session-continuity.md`).

opencode session-ids are persisted at `<project>/.claudecode-buddy/opencode/sessions/<key>-<role>-<model>.session-id` and reused on subsequent dispatches.
Key derivation is rule-based (no LLM): `feature/plan-NNN-*` → `plan-NNN`; other branches → `branch-<sanitised-branch-name>`; non-git → `scratch`.
`--session-key <name>` overrides; `--reset` deletes the stored id; `--no-session` skips reuse for one call without deletion.

The dispatcher (`lib/review-dispatch.mjs`) runs three defenses against silent stale-session failure modes:
1. **Pre-flight verification** via `opencode session list --format json` before passing `--session <id>`.
2. **Stderr-backup detection** (`Session not found: <id>`) handles the race window between pre-flight and run.
3. **Advisory mkdir-EEXIST lock** per (key, role, model) tuple serialises the load → invoke → save critical section. Lock contention causes the dispatcher to run in degraded mode (fresh + no save) instead of corrupting continuity.

Why: review rounds and run sessions benefit from prior-reasoning continuity, but only when scoped narrowly.
A single global session would leak unrelated work across reviews; a per-invocation fresh session loses the value of "the reviewer remembers what they said last round."
The (plan-or-branch, role, model) tuple captures the natural unit of "same conversation thread continuing."

Why pre-flight + stderr backup (not just one): opencode treats `--session <stale-id>` as a silent failure (exit 0 + empty body + `Session not found` in stderr only). Pre-flight catches the common case cheaply; stderr backup handles the race where the session is deleted between pre-flight and the run.

Why mkdir-EEXIST (not flock): mkdir is portable (works on macOS without coreutils) and atomic on POSIX. The simplified primitive has zero racing surface — only one process can succeed per (key, role, model) tuple.

**Known limitation (v0.3.0): no auto-reclamation of stranded locks.** A dispatch that crashes without releasing leaves a stranded lock until manually `rm`'d. The error message on the next acquisition includes the exact `rm -rf <path>` command. Auto-reclamation queued for plan 004 via proper `flock(2)` or `fcntl(F_SETLK)` semantics. Plan 002 rounds 3-6 attempted layered defenses against 3-party stale-reclamation races (rename-based atomic claim → post-rename stat verification → owner-token files with verify-after-write); each layer closed one race window and exposed a subtler one. The simpler design — drop reclamation, document manual recovery — has zero racing surface and ships in v0.3.0.

## D-011 — Stop-hook review gate is opt-in, fails open, smart-skips read-only turns

**Decided in:** plan 003 (`docs/plans/003-review-experience.md`).

The Stop-hook review gate is enabled per workspace via `<project>/.claudecode-buddy/opencode/config.json`'s `stopReviewGate` flag (default `false`). Toggle via `/opencode:gate on|off|status`. When ON, every Claude Code `Stop` event triggers a review of the working-tree state + the assistant's last message via `dispatchOpencode` with `role: "stop-gate"`. Verdict `needs-attention` → emit `{decision: "block", reason}` to Claude Code (forces Claude to address); verdict `approve` → pass through silently.

Three behaviours that diverge from codex's analogous hook:

1. **Smart-skip read-only turns via git state** (not `tool_uses` parsing). Authoritative signal is `git status --porcelain` plus `existsSync(.git)` pre-check. Codex's reference hook reads only `session_id`, `last_assistant_message`, `cwd` — never `tool_uses` — so a `tool_uses`-based heuristic would be unverified. Plus a meta-skip on `.claudecode-buddy/`-only changes (dispatcher self-edits during reviewer-dispatching turns).

2. **Fail open on review-system errors** — if the review invocation fails (binary missing, timeout, trailer parse error), log a warning to stderr and pass through (no `decision: block`). Codex fails closed.

   **Threat model for fail-open:** this is an *advisory development workflow safeguard*, NOT a security control. Its job is to catch the dominant Claude failure mode of "claimed work done but didn't actually verify" — a productivity issue, not an exploitation vector. Failing open preserves user productivity when the review system itself is misconfigured (opencode binary missing, model API outage, log-format change breaking the trailer parser). For genuine security gating (e.g., "block commits that fail license-compliance check"), fail-closed is correct — but plan 003 ships an advisory gate, and a broken advisory gate that strands the user is worse than a missing one. The hook explicitly logs warnings to stderr on every fail-open path so users notice when the gate isn't running.

3. **Opt-in via slash command + config file** — `/opencode:gate on|off|status` wraps the file edit. Codex requires direct config-file editing. The slash command makes the toggle discoverable.

**Workspace-config convention** (also established in this decision): each plugin owns `<project>/.claudecode-buddy/<plugin-name>/config.json` for runtime settings. `lib/config.mjs` provides the standard CRUD primitives (`loadConfig`, `updateConfig`, `DEFAULT_CONFIG`, `configPath`). Atomic `.tmp+rename` writes; partial-patch updates preserve unrelated keys (forward-compat for plans 004+).

**ESM ordering for the hook script** (matches plan-002 supervisor.mjs precedent): static imports of `node:*` built-ins ONLY (cannot fail at module load), register `uncaughtException` + `unhandledRejection` handlers, then `await import(...)` for own modules. Throws during own-module load hit the fail-open handlers.

---

## How to add a decision

When a plan makes a cross-cutting architectural decision (one that other plans will need to respect):

1. Add a new `## D-NNN — <short title>` section to this file.
2. State the decision in 1-2 sentences.
3. Link to the plan that introduced it (and the spec, if any).
4. Add a "Why" paragraph naming the trade-offs considered.

Decisions are append-only. If a later plan supersedes a decision, leave the original in place and add a new D-NNN that references and supersedes it.
