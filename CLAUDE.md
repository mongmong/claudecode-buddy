# Project Instructions

This workspace builds Claude Code plugins. The first plugin is `opencode` — a Claude Code wrapper around the [opencode](https://opencode.ai) CLI that exposes opencode as a review-only subagent and slash commands, mirroring the structure of OpenAI's `codex` plugin (`~/.claude/plugins/marketplaces/openai-codex/plugins/codex/`).

## CRITICAL RULES (never skip)

- **Always create a feature branch** before implementation. Never commit directly to main. Use `git checkout -b feature/plan-NNN-description`.
- **Always dispatch Codex AND opencode plan review before any implementation.** After saving a plan to `docs/plans/`, dispatch `codex:codex-rescue` AND run an opencode review (CLI today: `opencode run --dangerously-skip-permissions "<focused review prompt>"` from the repo root via the Bash tool — switch to `/opencode:review` or the `opencode:opencode-rescue` subagent once this workspace ships them). **Do NOT begin implementation until Claude, Codex, AND opencode agree** on the plan. If either reviewer flags blockers, revise the plan and re-dispatch BOTH reviews on the revised plan (so both verdicts apply to the final version). Iterate until all three concur. Capture both verdicts in the plan's `## Codex review summary` and `## Opencode review summary` sections.
- **Always code review** before creating a PR. Run BOTH `/codex:review` and an opencode review pass; write findings (tagged `[codex]` and `[opencode]`) to the plan file's `## Code Review` section.
- **Always write a post-execution report** in the plan file before shipping.
- **Always run the full test suite** before pushing. Do not push with failing tests.

## Project Structure

This workspace is in early scaffolding. Expected layout as it grows:

- `plugins/` — Claude Code plugins built here. The first one is `plugins/opencode/` — its layout mirrors `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/` (which has `commands/`, `agents/`, `skills/`, `hooks/`, `prompts/`, `schemas/`, and `.claude-plugin/plugin.json`).
- `.claude-plugin/marketplace.json` — Marketplace manifest (created when the first plugin is ready to publish).
- `docs/` — Documentation
  - `docs/plans/` — Execution plans (numbered sequentially: 000, 001, ..., 100, 101, ...). Sub-documents use letter suffixes (e.g. 106a, 106b).
  - `docs/specs/` — Design specs for large/novel features.
  - `docs/development-workflow.md` — The 6-step process every plan follows.
  - `docs/code-review.md` — Review process spec.
  - `docs/architecture/decisions.md` — Cross-cutting architectural decisions (created when the first decision is made).

The reference codex plugin is the canonical example of a working Claude-Code-wraps-an-external-CLI plugin. Read it before designing layout for this workspace's plugins:

- `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/commands/*.md` — slash command definitions (review, rescue, status, result, cancel, setup, adversarial-review).
- `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/agents/codex-rescue.md` — subagent definition.
- `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/skills/codex-cli-runtime/SKILL.md` — internal helper contract for invoking the wrapped CLI.
- `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/.claude-plugin/plugin.json` — plugin manifest.

## Architecture Decisions

When this workspace accumulates cross-cutting decisions (plugin layout conventions, runner contracts, prompt templates, error-handling patterns, etc.), record them in `docs/architecture/decisions.md`. Read that file before making changes that touch shared plugin infrastructure. Update it when a plan introduces new decisions.

Until the first decision lands, the only architectural rule is: **mirror the reference codex plugin's structure** unless a plan explicitly justifies departing from it.

## Coding Conventions

The plugin runtime is shaped by what Claude Code expects: Markdown for command/agent/skill definitions, JSON for manifests and hook configs, and shell or TypeScript/Node for any runner scripts (the codex marketplace uses `package.json` + `tsconfig.app-server.json`). Match conventions in the reference codex plugin when designing the opencode plugin layout.

### General

- Follow existing patterns in the reference codex plugin — check how similar features are implemented before writing new code.
- Never hardcode secrets or credentials. Secrets go in `.env` (gitignored), non-secret config in plugin manifests or settings.json.
- When modifying any logic, proactively search the codebase for similar patterns that should receive the same change. Do not wait to be asked — audit related commands, agents, and skills for consistency. If a fix applies to one slash command, check whether the others need it.
- **Never defer fixes without a follow-up plan.** If a known issue is identified during implementation, fix it NOW in the same commit/PR. Do NOT label it "acceptable trade-off", "follow-up", "TODO", or "deferred" unless a concrete follow-up plan has been drafted in `docs/plans/` with a plan number, scope, and phases. Unfiled deferrals rot.
- **Always implement the long-term solution, not the short-term workaround.** When two approaches exist — a quick hack vs a proper fix — choose the proper fix. If the proper fix is genuinely too large for the current scope, draft the follow-up plan immediately and get user approval before shipping the workaround.

## Testing

- When code is added or modified, write or update test cases covering the changes.
- Run the relevant tests to verify they pass before committing.
- Plugin tests: TBD as the test harness lands. At minimum, every slash command, subagent, and skill should have a smoke test that exercises the runner end-to-end against a real opencode CLI invocation.
- Test both happy paths and error/edge cases (opencode CLI unavailable, malformed prompt, timeout, missing model credentials, output that violates the expected schema).
- Aim for maximum test coverage: every public function, every branch, every error path. If a function has 3 code paths, write at least 3 tests. Do not skip edge cases.

## Documentation

When code changes affect plugin behavior, slash command interfaces, subagent prompts, or runner contracts, update the relevant documentation in `docs/` and any affected `README.md` files (root, `plugins/<plugin>/`, etc.) to stay in sync. This includes new commands, changed prompts, modified manifest fields, and updated setup steps.

## Git

- **Never commit directly to `main`.** Always create a feature branch and PR via `gh pr create`.
- Before merging any PR, check CI status with `gh pr checks <number>`. If any checks fail, fix the errors and push before merging. Never merge a PR with failing checks.
- Do not push to remote unless explicitly asked.
- Write clear, descriptive commit messages — lead with what changed and why, not how.
- Do not commit `.env`, credentials, or large binary files.
- Do not commit every small change individually. Batch related small fixes into a single meaningful commit.

## Plans

For substantial code changes — new plugins, new commands, runner refactors, marketplace integrations — always enter plan mode first and write a detailed plan before any implementation. Get user approval on the plan before proceeding.

**Execution plans** (phased implementation with file lists and verification steps) go in `docs/plans/`. Numbered sequentially (000, 001, ..., 100, 101, ...). Sub-documents use letter suffixes (106a, 106b).

**Design specs** go in `docs/specs/` — but only for large, novel, or cross-cutting designs that need a standalone reference document. When brainstorming produces a concrete design (components, file lists, phases decided), skip the spec and go straight to an execution plan in `docs/plans/`.

Before writing a new plan, review existing plans in `docs/plans/` for reusable patterns and architectural decisions that must be respected. Avoid introducing duplicate code — reuse existing implementations and keep logic in a single source of truth.

**Markdown formatting in plans / specs:** use **semantic line breaks** (one sentence per line) instead of hard-wrapping at a column limit.
Each sentence gets its own line.
Long sentences may break at a clause boundary (`,` `;` `—`) but not mid-clause.
Tables, code blocks, lists, and URLs follow their natural format — semantic line breaks only apply to prose paragraphs.
This convention produces cleaner `git diff` output (a sentence rewording changes one line, not a re-flowed paragraph) without the manual-rewrap cost of fixed column limits.

### Plan review gate (mandatory)

Every plan — new or revised — must pass BOTH a Codex review AND an opencode review before any code is written. This gate is the AI-review portion of `docs/development-workflow.md` Step 2 (steps 7–8); Step 2 also covers the surrounding save / user-approval / commit flow.

1. **Save the plan to `docs/plans/`** (uncommitted is fine — reviewers read from disk).
2. **Dispatch reviews in parallel:**
   - `codex:codex-rescue` with the plan path and explicit review questions (blockers, hidden assumptions, scope, ordering, missing risks). Keep the prompt focused — under 500 words, time-bounded.
   - `opencode run --dangerously-skip-permissions "<focused review prompt with the same questions>"` from the repo root via the Bash tool. (Once this workspace ships its own opencode plugin, switch to `/opencode:rescue` or the `opencode:opencode-rescue` subagent.)
3. **Capture both verdicts** in the plan file:
   - `## Codex review summary` — date, blockers, confirmations, resolution for each blocker.
   - `## Opencode review summary` — date, blockers, confirmations, resolution for each blocker.
4. **If either reviewer flags blockers, revise the plan** to address them. Re-dispatch BOTH reviews on the revised plan (so both verdicts apply to the final version) and re-embed the updated verdicts. Iterate until BOTH return no blockers AND Claude agrees with each resolution.
5. **AI review gate satisfied.** Hand off to `docs/development-workflow.md` Step 2 (steps 9–10) to complete: get final user approval, then commit the plan file with both review summaries embedded as the first commit on the feature branch. Only then begin implementation.

A plan that hasn't passed both reviews is not ready for execution, regardless of how confident Claude is in it. The three-model consensus (Claude + Codex + opencode) catches blind spots no single model can see — and since this workspace's *purpose* is to make opencode-as-reviewer ergonomic from inside Claude Code, eating our own dog food matters.

## Development Workflow

Follow `docs/development-workflow.md` exactly for every plan (Steps 1–6: Design → Plan → Build → Verify → Review → Ship). Do not skip steps or batch them. Key points:
- **Design before plan** — explore the problem, brainstorm approaches, align with user
- **Plan before code** — write and commit plan file (with both review summaries) before any implementation
- **Build phase by phase** — implement, test, self-review, document, commit each phase separately
- **Verify before review** — full test suite, cross-phase consistency check
- **Review before ship** — code review findings (both reviewers) in plan file, all [OPEN] items resolved
- **Ship cleanly** — post-execution report, update decisions.md if needed, then PR

## Code Review

Follow `docs/code-review.md` for the review process. Key points:
- Reviews go in the plan file's `## Code Review` section.
- Reviewers: append findings with `[OPEN]` status and file:line references.
- Authors: respond inline with `→ Response:` and `[FIXED]`/`[WONTFIX]`.
- **Run BOTH `/codex:review` AND an opencode review pass** before creating a PR. Tag findings `[codex]` or `[opencode]` so the source is clear. All `[OPEN]` items from either reviewer must be resolved before opening the PR.
- Opencode invocation (until the plugin ships): `opencode run --dangerously-skip-permissions "Code review the changes on this branch (run \`git diff main...HEAD\`). Focus on correctness, security, consistency with the reference codex plugin layout, and the rules in CLAUDE.md. Flag issues with file:line references and an [OPEN] tag."` — run from the repo root via the Bash tool.

## Coding Agent

**Claude Opus is the primary coding agent.** All implementation, debugging, refactoring, and coding tasks should be done by Claude (Opus model) — either directly or via subagents. Use the `superpowers:subagent-driven-development` skill for multi-task plan execution.

Do NOT delegate coding tasks to Codex or opencode. Both are review-only.

## Codex (GPT-5.5) — Review Only

**Use Codex exclusively for review tasks.** This is mandatory for plan review, but Codex should NOT be used for coding:

- **Plan review (BLOCKING — see "Plan review gate" above)** — every plan in `docs/plans/` must pass `codex:codex-rescue` review before any code is written. Implementation on a plan that hasn't been reviewed-and-agreed is a process violation.
- **Code review** — use `/codex:review` for branch-level review before creating PRs.
- **Spec review** — dispatch `codex:codex-rescue` to validate design specs in `docs/specs/`.
- **Implementation review** — dispatch `codex:codex-rescue` to verify implementations match their plan specifications.

Codex provides an independent second-model perspective (GPT-5.5) that catches issues Claude may miss. Codex review is non-optional for plans (alongside opencode); strongly recommended for everything else.

Do NOT use Codex for implementation, debugging, refactoring, or any coding work. Those belong to Claude Opus.

## Opencode — Review Only

**Use opencode exclusively for review tasks**, alongside Codex, to provide a third independent model perspective. Opencode runs through whichever LLM the user has configured in `~/.opencode/`, giving a different vantage point from Codex. Opencode should NOT be used for coding.

This workspace is BUILDING the opencode plugin, so until it ships, opencode is invoked via the CLI: `opencode run --dangerously-skip-permissions "<focused review prompt>"` from the repo root via the Bash tool. Once `/opencode:review` and `opencode:opencode-rescue` exist in this workspace, switch to those for cleaner ergonomics.

- **Plan review (BLOCKING — see "Plan review gate" above)** — every plan must pass an opencode review *in addition to* the Codex review before any code is written. Capture the verdict in the plan's `## Opencode review summary` section.
- **Code review** — run opencode alongside `/codex:review` for branch-level review before PRs. See the "Code Review" section above for the invocation pattern.
- **Spec review** — run opencode to validate design specs in `docs/specs/`, alongside the Codex spec review.
- **Implementation review** — run opencode to verify implementations match their plan specifications.

The three-model consensus (Claude + Codex + opencode) is the project standard for plan review. It catches blind spots that even two models can share.

Do NOT use opencode for implementation, debugging, refactoring, or any coding work. Those belong to Claude Opus.

## Multi-Agent Coordination

Multiple Claude Code sessions share the same local repository. Only one agent should work at a time. To avoid lost work:

- **Always commit before ending a session.** Even partial work — use a `WIP:` prefix. Uncommitted changes are invisible to the next session and will be lost.
- **Check `git status` at session start.** Look for untracked or modified files left by a previous session. Ask the user before discarding them.
- **Each plan uses a feature branch.** Pull before starting work, push before ending. Never leave unpushed commits.
- **Never assume prior session completed its work.** Verify by reading the plan file's post-execution report and checking git log — don't trust claims in conversation summaries alone.
