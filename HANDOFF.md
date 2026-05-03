# Handoff — Next Session

You're picking up `claudecode-buddy`. Read this first, then `CLAUDE.md`, then act.

## What this workspace is

A monorepo for building **Claude Code plugins**. The first plugin is `opencode` — a Claude Code wrapper around the [opencode](https://opencode.ai) CLI that exposes opencode as a review-only subagent + slash commands. The reference implementation to mirror is OpenAI's `codex` plugin at `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/` — same delegation pattern, different wrapped CLI.

**Why opencode-as-third-reviewer?** We want a third independent reviewer (alongside Claude and Codex) for plan, code, and spec review. Three-model consensus catches blind spots that two models share. opencode is the chosen third because (a) it runs any LLM via the user's `~/.opencode/` config, (b) it's already installed locally as `/home/chris/.opencode/bin/opencode` (v1.14.31), and (c) no published Claude Code plugin exists for it yet — we're building the missing piece.

## What's been done (bootstrap session, 2026-05-03)

Workspace was bootstrapped with adapted workflow scaffolding:

- `CLAUDE.md` — workflow rules tailored for plugin dev, including an "Opencode — Review Only" section and the dual Codex + opencode plan review gate.
- `docs/development-workflow.md` — Steps 2 and 5 embed the dual Codex + opencode review gate.
- `docs/code-review.md` — review template uses `[codex]` / `[opencode]` finding tags.
- `HANDOFF.md` (this file).

No code yet. No plans yet. No `plugins/` directory yet. The initial commit on `main` is **pending** — see "Open decisions" below.

## What to do next

Option B from the prior session: **build the opencode Claude Code plugin**. Recommended path:

1. **Read the reference plugin before brainstorming.** Specifically:
   - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/commands/*.md` — slash command definitions (`review`, `rescue`, `status`, `result`, `cancel`, `setup`, `adversarial-review`).
   - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/agents/codex-rescue.md` — subagent definition.
   - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/skills/codex-cli-runtime/SKILL.md` — runtime contract for invoking the wrapped CLI. This is the trickiest part to mirror; read carefully.
   - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/.claude-plugin/plugin.json` — manifest schema.
   - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/hooks/hooks.json` — any hooks the plugin installs.
   - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/schemas/review-output.schema.json` — structured-output expectation (does opencode need an equivalent?).
2. **Brainstorm with the user** via the `superpowers:brainstorming` skill before writing a plan. Open questions to resolve:
   - Plugin name — `opencode`? `opencode-rescue`? something else?
   - V1 command surface — full codex-style parity (`/opencode:review`, `/opencode:rescue`, `/opencode:status`, etc.) or minimal review-only (`/opencode:review` + `opencode:opencode-rescue` subagent)?
   - Output schema — does opencode CLI output need a schema like codex's `review-output.schema.json`?
   - Distribution — local install only, OpenAI-style standalone repo, or publish to a marketplace?
   - Test harness — codex plugin's tests live at `~/.claude/plugins/marketplaces/openai-codex/tests/`; mirror that approach?
3. **Write the plan** in `docs/plans/000-opencode-plugin-skeleton.md` (or pick a different starting number). Follow `docs/development-workflow.md` Step 2.
4. **Run the dual review gate** per CLAUDE.md → "Plan review gate". Both `codex:codex-rescue` AND `opencode run --dangerously-skip-permissions "<focused review prompt>"`. We eat our own dog food from day one — yes, including on the plan to build opencode-as-plugin.
5. **Implement phase by phase** per Step 3 of the workflow.

## Open decisions (resolve early in session 1)

- [ ] **Initial commit to `main`.** Workspace currently has uncommitted scaffolding (CLAUDE.md, docs/, this HANDOFF.md). The new CLAUDE.md forbids commits to `main`, but that rule doesn't exist until it's committed. Recommended: one foundational commit ("scaffold: workflow rules and handoff") to `main`, then all subsequent work follows the feature-branch + dual-review-gate flow.
- [ ] Plugin name (`opencode` vs alternatives) — settle in brainstorm.
- [ ] V1 command surface — full codex parity vs minimal review-only.
- [ ] Marketplace strategy — local-install-only vs published.
- [ ] Test harness shape.
- [ ] Whether this `HANDOFF.md` becomes a recurring convention (updated at end of every session) or a one-shot bootstrap doc. If recurring, add a rule to CLAUDE.md → "Multi-Agent Coordination" requiring it.

## Don't

- **Don't use opencode or Codex for *coding*.** Both are review-only. All coding is Claude Opus.
- **Don't skip the dual review gate, even on plan #1.** Especially on plan #1 — that's the precedent for everything that follows.
- **Don't commit directly to `main`** after the initial scaffolding commit.
