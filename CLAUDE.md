# Project Instructions

This workspace builds Claude Code plugins. It currently ships two:
- **`opencode`** — wraps the [opencode](https://opencode.ai) CLI.
- **`codex`** — wraps the [codex](https://github.com/openai/codex) CLI; full v0.5.1 parity with the opencode plugin. Replaces the third-party openai-codex plugin's `/codex:*` namespace (shipped in plan-007).

Both plugins expose the same surface: read-only review commands + subagents, write-capable run + background tasks, session continuity per `(plan-or-branch, role, model)` tuple, opt-in Stop-hook review gate.

## CRITICAL RULES (never skip)

- **Use Claude Sonnet 4.6 by default; promote to Opus 4.7 for complex work.** Routine coding (new commands, runner tweaks, tests, refactors, doc edits) runs on Sonnet. Reach for Opus 4.7 (1M context) when you hit cross-cutting design, hard debugging, or large-codebase reasoning. Do not delegate code generation to Codex, DeepSeek, GLM, or any other external model — those are review-only. See "Coding Agent" below for the escalation policy.
- **Always create the feature branch BEFORE drafting the plan.** Use `git checkout -b feature/plan-NNN-description` first. The plan file, review verdicts, and iterative revisions all commit to this branch — never to `main`. (The opencode session-continuity helper keys on `plan-NNN`-style branch names, so `feature/plan-NNN-*` is a precondition for reviewer session reuse.)
- **Always run the 4-way plan review before any implementation.** After drafting or revising any plan in `docs/plans/`, dispatch ALL four reviewers in parallel (see "Plan review gate" below): Self-review (Opus 4.7), Codex (`codex:codex-review` subagent — `codex:codex-rescue` works as a legacy alias), DeepSeek V4 Pro (`opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-pro`), and GLM 5.1 (`opencode:opencode-review` subagent with `--model volcengine-plan/glm-5.1`). Do NOT begin implementation until all four concur. Capture each verdict in the plan's `## Plan Review` section.
- **Always run the 4-way code review** before merging a PR. Dispatch all four reviewers in parallel (see "Code Review" below): Self-review (Opus 4.7), Codex (`/codex:review` interactive or `codex:codex-review` subagent), DeepSeek V4 Flash (`opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-flash`), and GLM 5.1 (`opencode:opencode-review` subagent with `--model volcengine-plan/glm-5.1`). Tag findings `[self-opus]`, `[codex]`, `[opencode:deepseek-v4-flash]`, `[opencode:glm-5.1]` in the plan's `## Code Review` section.
- **Always write a post-execution report** in the plan file before shipping.
- **Always run the full test suite** before pushing. Do not push with failing tests.

## Project Structure

This workspace is in early scaffolding. Expected layout as it grows:

- `plugins/` — Claude Code plugins built here. Currently: `plugins/opencode/` and `plugins/codex/`. Standard layout: `commands/`, `agents/`, `skills/`, `hooks/`, `prompts/`, `scripts/` (lib + buddy.mjs dispatcher), and `.claude-plugin/plugin.json`.
- `.claude-plugin/marketplace.json` — Marketplace manifest (created when the first plugin is ready to publish).
- `docs/` — Documentation
  - `docs/plans/` — Execution plans (numbered sequentially: 000, 001, ..., 100, 101, ...). Sub-documents use letter suffixes (e.g. 106a, 106b).
  - `docs/specs/` — Design specs for large/novel features.
  - `docs/development-workflow.md` — The 6-step process every plan follows.
  - `docs/code-review.md` — Review process spec.
  - `docs/architecture/decisions.md` — Cross-cutting architectural decisions (created when the first decision is made).

The workspace's own `plugins/opencode/` and `plugins/codex/` are now the canonical examples of working Claude-Code-wraps-an-external-CLI plugins. Read them before designing layout for new plugins:

- `plugins/opencode/commands/*.md` + `plugins/codex/commands/*.md` — slash command definitions (review, run, rescue, status, result, cancel, setup, gate).
- `plugins/opencode/agents/*.md` + `plugins/codex/agents/*.md` — subagent definitions.
- `plugins/opencode/skills/opencode-cli-runtime/SKILL.md` + `plugins/codex/skills/codex-cli-runtime/SKILL.md` — internal helper contracts for invoking the wrapped CLI.
- `plugins/opencode/scripts/buddy.mjs` + `plugins/codex/scripts/buddy.mjs` — dispatcher entry points.
- `plugins/*/.claude-plugin/plugin.json` — plugin manifests.

Historical note: the [openai-codex](https://github.com/openai/codex-plugin-cc) third-party plugin (at `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/`) was the original layout inspiration for plugin-000. Both opencode and the new codex plugin have evolved well beyond that baseline; the workspace's own plugins are the reference of record now.

## Architecture Decisions

When this workspace accumulates cross-cutting decisions (plugin layout conventions, runner contracts, prompt templates, error-handling patterns, etc.), record them in `docs/architecture/decisions.md`. Read that file before making changes that touch shared plugin infrastructure. Update it when a plan introduces new decisions.

Until the first decision lands, the only architectural rule is: **mirror the existing plugins' structure** (opencode + codex are both canonical examples) unless a plan explicitly justifies departing from it.

## Coding Conventions

The plugin runtime is shaped by what Claude Code expects: Markdown for command/agent/skill definitions, JSON for manifests and hook configs, Node ESM (`.mjs`) for runner scripts. Both `plugins/opencode/` and `plugins/codex/` use the same convention — dep-free Node + workspace-level `tests/<plugin>/*.test.mjs` via `node:test`. Match these conventions when adding a new plugin.

### General

- Follow existing patterns in `plugins/opencode/` and `plugins/codex/` — check how similar features are implemented before writing new code.
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

**Design specs** go in `docs/specs/` — only when the work introduces or refines an *architectural* decision or resolves a cross-cutting *ambiguity* that other plans will need to respect. Specs hold the long-lived "what is this system shaped like, and why?". They do NOT hold execution detail (file lists, phase order, code blocks, test cases) — that belongs in the plan. A new plan touching an existing spec amends the spec inline rather than starting a new file.

**Rule of thumb:**
- Architectural decision or cross-cutting ambiguity? → spec.
- Execution-level detail (which files, what code, what tests)? → plan.
- Both? → amend the spec, then write the plan referencing the updated spec.

`docs/architecture/decisions.md` is the *index* of cross-cutting decisions (one-line entries); the full design context lives in the relevant spec.

Before writing a new plan, review existing plans in `docs/plans/` for reusable patterns and architectural decisions that must be respected. Avoid introducing duplicate code — reuse existing implementations and keep logic in a single source of truth.

**Markdown formatting in plans / specs:** use **semantic line breaks** (one sentence per line) instead of hard-wrapping at a column limit.
Each sentence gets its own line.
Long sentences may break at a clause boundary (`,` `;` `—`) but not mid-clause.
Tables, code blocks, lists, and URLs follow their natural format — semantic line breaks only apply to prose paragraphs.
This convention produces cleaner `git diff` output (a sentence rewording changes one line, not a re-flowed paragraph) without the manual-rewrap cost of fixed column limits.

### Plan review gate (mandatory — 4-way)

Every plan — new or revised — must pass a 4-way review before any code is written. The four reviewers run **in parallel** (dispatch all simultaneously via multiple Agent / subagent calls in a single message):

| # | Reviewer | How to dispatch | Model |
|---|----------|-----------------|-------|
| 1 | **Self-review (Opus 4.7)** | Claude reads its own plan critically on Opus and lists concerns inline | claude-opus-4-7 |
| 2 | **Codex** | `codex:codex-review` subagent with the plan path + review questions (or `codex:codex-rescue` — legacy alias) | Codex default |
| 3 | **DeepSeek V4 Pro** | `opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-pro` | deepseek/deepseek-v4-pro |
| 4 | **GLM 5.1** | `opencode:opencode-review` subagent with `--model volcengine-plan/glm-5.1` | volcengine-plan/glm-5.1 |

Steps:

1. **Create the feature branch FIRST** — `git checkout -b feature/plan-NNN-description` before any plan drafting. Every commit (the plan file, the review verdicts, the iterative revisions) lands on the feature branch, never on `main`. The opencode session-continuity helper keys on `plan-NNN`, so reviewer history scopes correctly when the branch matches `feature/plan-NNN-*`.
2. **Draft or revise the plan** in `docs/plans/`. Commit it to the feature branch so the reviewers can read the same on-disk file Claude is iterating on.
3. **Run self-review (Opus 4.7)** — Claude reads the plan with fresh eyes on Opus and records any concerns inline. Self-review ALWAYS runs on Opus, regardless of which tier wrote the plan (see "Coding Agent" → "Self-review always runs on Opus 4.7").
4. **Dispatch reviewers 2-4 in parallel** — same focused prompt to each (plan path + explicit review questions: blockers, hidden assumptions, scope, ordering, missing risks). Keep each prompt under ~500 words and time-bounded. Use the `Agent` tool with `subagent_type: "codex:codex-review"` (or `codex:codex-rescue` as legacy alias) for Codex and `subagent_type: "opencode:opencode-review"` for the two opencode reviewers — both opencode-style subagents accept the model pin in their prompt and forward it to the underlying `--model` flag.
5. **Capture all four verdicts** in the plan's `## Plan Review` section. Include the date, the reviewer name, the verdict, the blockers, and the resolution for each blocker. Commit the verdicts to the feature branch as they arrive — don't batch the audit trail.
6. **If ANY reviewer flags blockers, revise the plan** to address them on the same feature branch. Re-dispatch only the flagging reviewer(s) on the revised plan. Iterate until all four concur.
7. **Only then** begin implementation on the same branch. The plan file with the 4-way review summary is already committed; the next commits are the implementation.

A plan that hasn't passed all four reviews is not ready for execution, regardless of how confident Claude is in it. The multi-model consensus catches blind spots no single model can see — and since this workspace's *purpose* is to make opencode-as-reviewer ergonomic from inside Claude Code, eating our own dog food matters.

**Session continuity (v0.3.0+, plan 002):** the opencode subagent automatically resumes the prior session for `(plan-or-branch, role, model)` between rounds, so the reviewer remembers what they said in earlier rounds. No invocation change needed — the dispatcher handles it. If a reviewer's session gets confused, pass `--reset` to start fresh on the next round.

**Adversarial review (v0.4.0+, plan 003):** for plan or code reviews where you want a hostile-perspective second opinion, pair an adversarial reviewer alongside the friendly one — pass `--style adversarial` to `/opencode:review`. Adversarial reviews run under a distinct session-continuity tuple (role=`review-adversarial`) so they don't pollute the friendly reviewer's history. Useful when the friendly review approves but you want a "could this still be wrong?" second pass.

**Stop-hook review gate (v0.4.0+, plan 003, opt-in):** `/opencode:gate on` enables an automatic review on every Claude Code `Stop` event. The gate runs `/opencode:review`-equivalent checks against the working-tree state + the assistant's last message; verdict `needs-attention` blocks Claude's stop with the findings. Smart-skips read-only turns (no git changes) and fails open when the review system itself is broken. `/opencode:gate off` to disable; `/opencode:gate status` to check. Recommended for users who want a safety net but DON'T turn it on for every project — it adds latency and API cost on every actionable turn.

### Handling hung reviews

> **Scope:** the plugin is the routine review path — `/opencode:review` (interactive) or `Agent({subagent_type: "opencode:opencode-review"})` (programmatic). This section covers raw `opencode run` bash invocations as a **debugging escape hatch** when a plugin-dispatched review hangs and you need live event-stream visibility the plugin doesn't surface. Do NOT use raw bash invocation as the routine review path.

opencode runs occasionally hang (model API unresponsive, rate limits, network issue). Symptoms:

- Background task elapsed time exceeds the typical review duration (~3-5 min for a small plan).
- The captured output file stops growing.
- The opencode log at `~/.local/share/opencode/log/<timestamp>.log` shows only the initial INFO line and no subsequent activity.

**CPU usage is NOT a reliable signal** — LLM API calls are network-bound and consume ~0% CPU while waiting on the model.

**Pick the right dispatch pattern for the goal:**

| Goal | Flags | Stdout shape |
|---|---|---|
| Routine review (just want the verdict prose) | `--format default --print-logs --log-level INFO` | Clean human-readable output |
| Programmatic parsing (companion script extracts text events) | `--format json --print-logs --log-level INFO` | NDJSON; filter `type=text` |
| Debugging a specific run (want thinking visible) | `--thinking --format default --print-logs --log-level INFO` | Thinking blocks render inline |
| Full event-stream debugging | `--thinking --format json --print-logs --log-level INFO` | NDJSON; `type` ∈ {`text`, `thinking`, tool events} — verbose |

**Common pitfall:** `--thinking --format json` together means thinking events are interleaved with text events in stdout, making the file noisy when you only want the assistant's final answer. Use `--format default` for routine reviews; reserve `--format json` for tools that actually parse the stream.

**Recommended dispatch pattern (avoids buffering the heartbeat):**

```bash
# WRONG — `| tail` buffers; you can't see incremental events.
opencode run --model X --dangerously-skip-permissions "..." 2>&1 | tail -200

# RIGHT (routine review) — direct stdout/stderr capture, default formatting.
opencode run \
  --model X \
  --print-logs --log-level INFO \
  --format default \
  --dangerously-skip-permissions \
  "$(cat /tmp/prompt.txt)" \
  < /dev/null \
  > /tmp/review.out 2> /tmp/review.err
```

Why each flag matters:

- `--print-logs --log-level INFO` — emits per-event log lines to **stderr** (`message.part.delta publishing`, etc.) so the err-file growth is the heartbeat. Without this, the only signal is stdout, which buffers per assistant message.
- `--format default` — clean human-readable output to stdout. Add `--thinking` to inline thinking blocks when actively debugging a stuck run; otherwise omit it (thinking content is otherwise noise).
- `--format json` — raw NDJSON event stream for programmatic consumers (the companion script). Each line is parseable; `type` ∈ {`text`, `thinking`, `tool_call_start`, `tool_call_finish`, ...}. Use `jq -c 'select(.type=="text") | .part.text'` to extract assistant text only.
- `< /dev/null` — close stdin explicitly. Without this, opencode can wait on stdin EOF and appear hung.
- Prompt via `$(cat /tmp/prompt.txt)` — write the prompt to a file via a quoted-delimiter heredoc to dodge shell quoting traps and ARG_MAX risk. Same pattern as the `opencode-review` subagent uses internally.

**Live tailing for debugging:**

```bash
# Watch heartbeat (per-event INFO logs)
tail -f /tmp/review.err

# Watch thinking + tool calls + text deltas as they arrive
tail -f /tmp/review.out | jq -c 'select(.type | IN("thinking","tool_call_start","tool_call_finish","text")) | {type, text: (.part.text // .part.tool // ""), id: (.part.messageID // "")}'

# Extract just the final assistant text (the review verdict) when done
jq -r 'select(.type=="text") | .part.text' /tmp/review.out | tail -c 4000
```

**Recovery procedure when a review is hung:**

1. Verify hang by checking the output file size: if no growth for >60s and the opencode log shows no progress, the run is genuinely stuck.
2. Kill the process (`kill <pid>`).
3. **Try `--reset` first** (v0.3.0+) — if the issue is a confused reviewer session rather than the model itself, re-dispatch the plugin command with `--reset` (e.g., `/opencode:review --reset --model <id>`, or pass `--reset` in the subagent prompt). This discards the stored session-id and starts fresh. Often resolves the hang without changing models.
4. If `--reset` doesn't help, re-dispatch the plugin command with a different model from the same tier (e.g., substitute `volcengine-plan/glm-5.1` for `deepseek/deepseek-v4-pro` if the latter hangs).
5. Note the substitution explicitly in the review verdict header so the model used is auditable.

Plan 002 (v0.3.0) shipped session continuity with `--reset` as the recovery primitive. A future plan may add `scripts/dispatch-review.sh` for automated hang detection (file-growth poll) and fallback-model retry.

## Development Workflow

Follow `docs/development-workflow.md` exactly for every plan (Steps 1–6: Design → Plan → Build → Verify → Review → Ship). Do not skip steps or batch them. Key points:
- **Design before plan** — explore the problem, brainstorm approaches, align with user
- **Plan before code** — write and commit plan file (with all four plan-review verdicts) before any implementation
- **Build phase by phase** — implement, test, self-review, document, commit each phase separately
- **Verify before review** — full test suite, cross-phase consistency check
- **Review before ship** — code review findings (all four reviewers) in plan file, all [OPEN] items resolved
- **Ship cleanly** — post-execution report, update decisions.md if needed, then PR

## Code Review

Follow `docs/code-review.md` for the review process. Reviews use the same 4-way pattern as plans but with a **flash-tier model for DeepSeek** (code reviews are more frequent and latency-sensitive):

| # | Reviewer | How to dispatch | Model |
|---|----------|-----------------|-------|
| 1 | **Self-review (Opus 4.7)** | Claude reads the diff critically on Opus before dispatching | claude-opus-4-7 |
| 2 | **Codex** | `/codex:review` (interactive) or `codex:codex-review` subagent with branch diff + review questions (`codex:codex-rescue` is a legacy alias of the same subagent) | Codex default |
| 3 | **DeepSeek V4 Flash** | `opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-flash` | deepseek/deepseek-v4-flash |
| 4 | **GLM 5.1** | `opencode:opencode-review` subagent with `--model volcengine-plan/glm-5.1` | volcengine-plan/glm-5.1 |

Key points:
- All four reviewers dispatch **in parallel** (multiple Agent calls in one message) after the self-review pass.
- Reviews go in the plan file's `## Code Review` section.
- Reviewers: append findings with `[OPEN]` status and file:line references.
- Authors: respond inline with `→ Response:` and `[FIXED]`/`[WONTFIX]`.
- Tag findings `[self-opus]`, `[codex]`, `[opencode:deepseek-v4-flash]`, `[opencode:glm-5.1]` so the source is clear. All `[OPEN]` items from ANY of the four reviewers must be resolved before opening the PR.
- Opencode invocations: dispatch `opencode:opencode-review` via the `Agent` tool TWICE in parallel (once per opencode model), each with prompt: "Code review the changes on this branch (run `git diff main...HEAD`). Focus on correctness, security, consistency with the existing `plugins/opencode/` and `plugins/codex/` layout, and the rules in CLAUDE.md. Flag issues with file:line references and an [OPEN] tag." The orchestrator passes the appropriate `--model` flag in the bash heredoc the subagent runs (see the subagent doc for the heredoc + `--model` example).
- If ANY reviewer flags a blocker, fix it before merging. Re-dispatch only the flagging reviewer(s) to confirm the fix.

## Coding Agent

This workspace uses a **two-tier Claude coding policy** — Sonnet 4.6 for the bulk of routine work, Opus 4.7 for the genuinely hard parts. The model in use should match the difficulty of the task, not the prestige of the plan.

### Claude Sonnet 4.6 — general coding agent (default)

Use Sonnet for the bulk of day-to-day implementation:
- All test code (smoke tests, runner tests, fixtures, helpers) — pattern-heavy, repetitive, fast feedback loop.
- New slash commands / subagents / skills following an established pattern.
- Wiring changes (manifest fields, hook configs, plugin metadata bumps).
- Refactors with a clear before/after shape.
- Doc updates, CHANGELOG entries, dependency bumps, copy edits.
- Small bug fixes where the root cause is already known.
- Applying review findings.

### Claude Opus 4.7 — complex coding agent (1M context)

Escalate to Opus when:
- Designing a new architectural pattern or cross-cutting abstraction.
- Debugging a non-obvious issue with multi-system surface area (race conditions, supervisor lifecycle, hook ordering, cross-process locking).
- Implementing the first phase of a plan that establishes patterns later phases will follow.
- Reading a large unfamiliar codebase to plan a refactor.
- Tasks that genuinely benefit from the 1M context window.
- Anything where Sonnet has already attempted and gotten stuck.

When in doubt, start with Sonnet. Promote to Opus only when the work clearly warrants it — Opus is more expensive, slower, and shouldn't be the reflex choice. Promotion mid-task is fine: if Sonnet hits a wall, hand off to Opus with the conversation context intact. The user may pin a model with `/model` at any time — respect that override. Use the `superpowers:subagent-driven-development` skill for multi-task plan execution regardless of which Claude model is driving.

### Self-review always runs on Opus 4.7

The **self-review stage** of both gates (plan review #1 and code review #1) ALWAYS runs on Opus 4.7, regardless of which tier wrote the plan or code. Review is judgment-heavy and load-bearing — a routine implementation deserves a careful review, and the cost gap between Sonnet and Opus on a single review pass is dwarfed by the cost of shipping a flaw that the gate should have caught. Switch to Opus before invoking the self-review step.

### Both tiers — same rules

- Do NOT delegate coding tasks to Codex, DeepSeek, or GLM. Those models are review-only (see "External Reviewers" below).
- Both tiers follow the 4-way review gates for plans and code (with Opus on self-review, see above).
- Both tiers respect the branch-first rule and the development workflow.
- opencode itself became write-capable in plan 001 via `/opencode:run` — but it's a *secondary* delegation channel, not a coding agent in the policy sense. Use `/opencode:run --yolo` (with explicit user consent) only for narrowly-scoped delegations where you want a different model's perspective on a specific change. Default coding work stays on Claude (Sonnet by default, Opus for complex tasks).

## External Reviewers (Review Only)

Three external review models complement Claude's self-review. None of them implement code — they review only.

### Codex
- Dispatch: `codex:codex-review` subagent (programmatic; `codex:codex-rescue` works as legacy alias) or `/codex:review` / `/codex:rescue` (interactive).
- Plugin source: claudecode-buddy/codex (replaced the third-party openai-codex plugin's `/codex:*` namespace in plan-007). If both plugins are installed simultaneously the namespace collision is undefined — uninstall openai-codex first (see workspace README's "Migrating from openai-codex" section).
- Use for: plan reviews, code reviews, spec reviews, post-impl reviews.
- Prompt style: under 500 words, focused questions (blockers, hidden assumptions, scope, ordering, missing risks), time-bounded.

### DeepSeek (via opencode)
- Plan reviews: `opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-pro`.
- Code reviews: `opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-flash` (faster for frequent post-impl passes).
- Prompt style: same prompt as Codex (plan path + questions, or branch diff + questions). The opencode subagent accepts free-form prompt text forwarded to the model along with the `--model` pin in the bash heredoc.

### GLM 5.1 (via opencode)
- All reviews: `opencode:opencode-review` subagent with `--model volcengine-plan/glm-5.1`.
- Prompt style: same as above.

Do NOT use any of these for implementation, debugging, refactoring, or coding. Those belong to Claude Sonnet 4.6 (default) or Opus 4.7 (complex) — see "Coding Agent" above.

### Opencode plugin context

opencode is the third independent code-review (and selectively, write-capable) agent in this workspace, alongside Claude and Codex. The plugin lives at `plugins/opencode/` and was built up over phased plans:

- **v0.1.0 (plan 000):** read-only review — `/opencode:review`, `/opencode:setup`, `opencode:opencode-review` subagent.
- **v0.2.0 (plan 001):** write-capable run + background tasks — `/opencode:run`, `--background`, `/opencode:status` / `/opencode:result` / `/opencode:cancel`, `opencode:opencode-run` subagent.
- **v0.3.0 (plan 002):** review session continuity per `(plan-or-branch, role, model)` tuple.
- **v0.4.0 (plan 003):** `--style adversarial` flag + opt-in Stop-hook review gate.
- **v0.4.0+ (plan 004):** GitHub-installable marketplace via `.claude-plugin/marketplace.json` (D-012).

opencode runs whichever LLM the user has configured in `~/.config/opencode/opencode.json`. The plugin is model-agnostic — it never embeds a default model. The user's `~/.config/opencode/opencode.json` must define the models referenced in this workspace's review pipeline:

- `deepseek/deepseek-v4-pro` — plan-review gate (one of three external reviewers alongside Codex and GLM).
- `deepseek/deepseek-v4-flash` — code-review pipeline (one of three external reviewers).
- `volcengine-plan/glm-5.1` — both pipelines (the GLM 5.1 reviewer).

The pinned models give plan reviews and code reviews each a deliberate, reproducible model mix; pinning keeps the 4-way review consensus stable across reviews instead of drifting whenever the user's default model changes.

**Dispatch always goes through the plugin**, never raw CLI. Use `/opencode:review` for interactive review and `Agent({subagent_type: "opencode:opencode-review", prompt: "..."})` for programmatic dispatch (e.g., the 4-way plan-review gate). The subagent forwards `--model <id>` to the underlying `opencode run` invocation. (Raw `opencode run --model X --dangerously-skip-permissions "..."` bash invocations are reserved for low-level debugging of stuck reviews — see "Handling hung reviews" below — not for the routine review path.)

## Multi-Agent Coordination

Multiple Claude Code sessions share the same local repository. Only one agent should work at a time. To avoid lost work:

- **Always commit before ending a session.** Even partial work — use a `WIP:` prefix. Uncommitted changes are invisible to the next session and will be lost.
- **Check `git status` at session start.** Look for untracked or modified files left by a previous session. Ask the user before discarding them.
- **Each plan uses a feature branch.** Pull before starting work, push before ending. Never leave unpushed commits.
- **Never assume prior session completed its work.** Verify by reading the plan file's post-execution report and checking git log — don't trust claims in conversation summaries alone.
