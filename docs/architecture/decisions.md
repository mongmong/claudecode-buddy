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

Each plugin's runtime lives in a single Node ESM file (`scripts/<plugin>-companion.mjs`) with subcommand routing. Pure utilities split into `scripts/lib/*.mjs`. No external runtime dependencies (Node ≥ 18.18 built-ins only) for v1.

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

---

## How to add a decision

When a plan makes a cross-cutting architectural decision (one that other plans will need to respect):

1. Add a new `## D-NNN — <short title>` section to this file.
2. State the decision in 1-2 sentences.
3. Link to the plan that introduced it (and the spec, if any).
4. Add a "Why" paragraph naming the trade-offs considered.

Decisions are append-only. If a later plan supersedes a decision, leave the original in place and add a new D-NNN that references and supersedes it.
