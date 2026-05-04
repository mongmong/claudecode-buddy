# Development Workflow

Follow this process for every plan. Do NOT skip steps or batch them.

For trivial changes (typo fixes, one-line patches), use your judgement — not every change needs the full workflow. But any multi-file feature, refactor, or integration must follow it.

---

## Step 1 — Design

Explore the problem space before committing to an approach.

1. Clarify the user's intent — what problem are we solving, what does success look like?
2. Research constraints: read `docs/architecture/decisions.md` (if it exists), check relevant code, identify affected systems.
3. Brainstorm approaches. Compare trade-offs. Identify risks.
4. Get user alignment on the approach before writing a plan.

**Output:** One of the following, depending on complexity:
- **Verbal alignment** — for simple, well-defined tasks. Proceed directly to Plan.
- **Straight to plan** — when brainstorming produces a concrete design (components, file lists, phases, testing strategy). No spec needed.
- **Design spec** in `docs/specs/` — only for large, novel, or cross-cutting designs that will be referenced by multiple plans or need a standalone reference document.

**Skip when:** The task is well-defined with an obvious approach (e.g., "add slash command X to plugin Y").

---

## Step 2 — Plan

Write a concrete execution plan with phases, files, tests, and verification steps.

1. Read `docs/architecture/decisions.md` if it exists. Ensure the plan respects all existing rules.
2. Read existing plans in `docs/plans/` for reusable patterns and established conventions.
3. Read `TODO.md` (if it exists) for outstanding items relevant to this work.
4. Write a detailed plan with: phases, file lists, testing plan per phase (files, functions, expected coverage), and verification steps.
5. Self-review the plan: check for inconsistencies, missing files, stale references, blast radius, naming conflicts, edge cases.
6. **Save the plan to `docs/plans/`** with the next sequential number (e.g., `docs/plans/007-feature-name.md`). Reference the design spec if one exists. The file does NOT need to be committed yet — saving makes it readable to reviewers.
7. **Dispatch the dual review gate** (see CLAUDE.md → "Plan review gate"): both `codex:codex-rescue` and an opencode review pass, run against the saved plan file. Embed both verdicts in the plan file under `## Codex review summary` and `## Opencode review summary`.
8. **If either reviewer flags blockers**, revise the plan, re-dispatch BOTH reviews on the revised plan (so both verdicts apply to the final version), and re-embed the updated verdicts. Iterate until both reviewers return no blockers AND Claude agrees with each resolution.
9. **Get user approval on the reviewed plan.**
10. **Commit the plan file** with both review summaries embedded — this is the first commit on the feature branch, before any implementation code.

**Output:** Committed plan file in `docs/plans/`, with both review summaries embedded and user approval secured.

---

## Step 3 — Build

Implement the plan phase by phase. Do not batch phases.

For **each phase**:

1. **Implement** — write the code for this phase only.
2. **Test** — write or update tests following the Testing guidelines. Run all relevant tests. Fix failures before proceeding.
3. **Self-review** — re-read all modified files. Compare against the plan and `docs/architecture/decisions.md`. Check for consistency, dead code, duplicate logic.
4. **Document** — update `docs/` and affected `README.md` files for this phase's changes.
5. **Commit** — only after tests pass and self-review is clean. Commit code, tests, and docs together.

When tasks within a plan are independent and can be implemented without shared state, dispatch them to subagents in parallel via the Agent tool. When tasks have sequential dependencies, execute them in order in the current session.

When a test fails or behavior is unexpected, debug systematically: reproduce the failure deterministically, isolate the smallest case, form a hypothesis, verify by changing one thing at a time. Don't guess at fixes.

---

## Step 4 — Verify

After all phases are complete, verify the whole before moving on.

1. Run the **full** test suite (not just changed tests). All must pass.
2. Check cross-phase consistency: duplicated code, inconsistent patterns, missed edge cases.
3. Compare actual test coverage against the plan's testing plan. Add any missing tests.
4. If issues are found, fix them following the Build step's per-phase process.

Before claiming work is done, run the verification commands and confirm the actual output. Don't assert success without evidence.

---

## Step 5 — Review

Code review catches what self-review misses. Run THREE independent reviewers: `/codex:review` (Codex on gpt-5.5), opencode pinned to `deepseek/deepseek-v4-flash`, and opencode pinned to `volcengine-plan/glm-5.1`. After plan 000 ships, dispatch the two opencode reviewers via the `opencode:opencode-review` subagent in parallel, each with a different `--model`. Before plan 000 ships, fall back to two parallel `opencode run --model <model> --dangerously-skip-permissions "..."` invocations. (Plan reviews use a different mix: Codex + opencode pinned to `deepseek/deepseek-v4-pro`. See CLAUDE.md → "Plan review gate".)

1. Request all three code reviews (Codex + two opencode passes with different models). Each reviewer appends findings to the plan file's `## Code Review` section, following `docs/code-review.md` format. Findings are tagged `[codex]`, `[opencode:deepseek-v4-flash]`, or `[opencode:glm-5.1]` so the source is clear.
2. Each finding is numbered with `[OPEN]` status, file:line references, and Must Fix / Should Fix / Nice to Have priority.
3. Author addresses each finding: fix the code or explain why not. Respond inline with `→ Response:` and update status to `[FIXED]` or `[WONTFIX]`.
4. All `[OPEN]` items from ANY of the three reviewers must be resolved before shipping.

When acting on review feedback, evaluate each finding rigorously before implementing — don't blindly apply suggestions. If a finding is unclear or technically questionable, push back with reasoning rather than agreeing performatively.

---

## Step 6 — Ship

Wrap up, push, and create the PR.

1. **Update the plan file** with a post-execution report: implementation details, deviations from plan, known limitations, follow-up work.
2. **Update `docs/architecture/decisions.md`** if new architectural decisions were made (create the file if it doesn't yet exist).
3. **Update `TODO.md`** — mark completed items, add new follow-up items.
4. **Commit** the updated plan and docs.
5. **Run ALL tests** one final time. Do not proceed if any test fails.
6. **Push** the branch and **create a PR** via `gh pr create`.

---

## Session Handoff Rules

Multiple Claude Code sessions share the same local repository sequentially. To prevent lost work:

1. **Commit everything before ending.** Every file change — code, plan files, docs, review findings — must be committed before the session ends. Use `WIP:` prefix for incomplete work. Uncommitted changes are invisible to the next session.
2. **Push the branch.** Don't leave unpushed commits. The next session may start on a different branch or after a `git pull`.
3. **Check `git status` on session start.** Look for untracked or modified files from a prior session. These are orphaned changes that need to be committed or discarded (ask the user).
4. **Don't trust conversation summaries.** Verify prior work by checking `git log`, reading plan files, and confirming post-execution reports exist. A summary may claim work was done that was never committed.
