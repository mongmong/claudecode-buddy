# Code Review Process

Code review happens after the implementation is complete (Step 5 in `docs/development-workflow.md`). It is distinct from the plan review gate (CLAUDE.md → "Plan review gate"), which runs before any code is written; this document covers post-implementation code review only.

The plan file's `## Code Review` section is the communication channel between reviewers and authors. Both parties use the same document — reviewers add findings, authors respond inline.

This workspace runs **two independent reviewers** on every code review pass: Codex (`/codex:review`) and opencode (`opencode run --dangerously-skip-permissions "..."` until the local opencode plugin ships its own slash command). Each finding is tagged `[codex]` or `[opencode]` so its source is clear.

## For reviewers

When performing a code review (via `/codex:review`, opencode CLI, or on request), append a new review round to the `## Code Review` section in the relevant plan file in `docs/plans/`. Format:

```markdown
### Review N — [codex] or [opencode]

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

All `[OPEN]` items from EITHER reviewer must be resolved before merging the PR.
