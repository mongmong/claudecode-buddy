# Code Review Process

Code review happens after the implementation is complete (Step 5 in `docs/development-workflow.md`). It is distinct from the plan review gate (CLAUDE.md → "Plan review gate"), which runs before any code is written; this document covers post-implementation code review only.

The plan file's `## Code Review` section is the communication channel between reviewers and authors. Both parties use the same document — reviewers add findings, authors respond inline.

This workspace runs **three independent reviewers** on every code review pass:

1. Codex on gpt-5.5 — invoked via `/codex:review`.
2. opencode pinned to model `deepseek/deepseek-v4-flash` — dispatched via the `opencode:opencode-review` subagent with `--model deepseek/deepseek-v4-flash`.
3. opencode pinned to model `volcengine-plan/glm-5.1` — dispatched via the `opencode:opencode-review` subagent with `--model volcengine-plan/glm-5.1`.

(Plan reviews use a different mix: Codex on gpt-5.5 + opencode pinned to `deepseek/deepseek-v4-pro`. See CLAUDE.md → "CRITICAL RULES" and "Plan review gate".)

Before plan 000 ships, the opencode reviewers fall back to `opencode run --model <model> --dangerously-skip-permissions "..."` invoked from the repo root via the Bash tool, run twice (once per model).

Findings are tagged so the source is clear:
- `[codex]` for Codex findings.
- `[opencode:deepseek-v4-flash]` for findings from the deepseek-v4-flash opencode pass.
- `[opencode:glm-5.1]` for findings from the glm-5.1 opencode pass.

## For reviewers

When performing a code review (via `/codex:review`, the opencode subagent, or opencode CLI), append a new review round to the `## Code Review` section in the relevant plan file in `docs/plans/`. Format:

```markdown
### Review N — [codex] | [opencode:deepseek-v4-flash] | [opencode:glm-5.1]

- **Date**: YYYY-MM-DD
- **Reviewer**: Codex / opencode (model name) / Claude / human name
- **PR**: #N — title
- **Verdict**: Approved / Approved with suggestions / Changes requested

**Must Fix / Should Fix / Nice to Have**

1. `[OPEN]` Finding description with file:line references.
2. `[OPEN]` Another finding.
```

Each finding gets a numbered item with `[OPEN]` status. Prioritize as Must Fix / Should Fix / Nice to Have. Include file paths and line numbers. End with a 2–4 sentence summary.

If no plan file corresponds to the reviewed PR/branch, create a stub entry in the nearest matching plan file or note the absence explicitly.

## For authors

After addressing review findings, respond inline under each item:

```markdown
1. `[FIXED]` Finding description.
   → Response: What was done, commit ref.

2. `[WONTFIX]` Finding description.
   → Response: Why — e.g., deferred to Plan XXX, or by design.
```

Status values: `[OPEN]` (unaddressed), `[FIXED]` (resolved), `[WONTFIX]` (intentionally not fixing, with reason).

After responding to all findings, the reviewer (or a follow-up review round) can verify fixes and close the review, or add new findings as "Review N+1".

All `[OPEN]` items from ANY of the three reviewers must be resolved before merging the PR.
