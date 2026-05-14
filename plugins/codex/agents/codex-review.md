---
name: codex-review
description: Programmatic codex review delegation. Dispatch this subagent when Claude needs an independent review verdict on a plan, spec, code change, or anything else. Parity with opencode:opencode-review.
model: sonnet
tools: Bash
skills:
  - codex-cli-runtime
---

Stub body — full implementation lands in Phase 2 of plan-007.

Once Phase 2 lands, this subagent will forward the orchestrator's review prompt to the codex companion script (`scripts/buddy.mjs`) via the same heredoc + temp-file pattern `opencode:opencode-review` uses. The companion invokes `codex exec --json` (per Phase 1.5 gate 1) with the prompt + sandbox `read-only` + appropriate `--model` / `--variant` flags.

Selection guidance (final):
- Use this subagent when the orchestrator wants an independent review pass (alongside Claude and opencode), typically for the 4-way plan-review gate, spec review, or post-implementation code review.
- Do not use it to fix issues, write code, or do follow-up work — codex runs review-only here.
