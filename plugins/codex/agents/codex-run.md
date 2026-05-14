---
name: codex-run
description: Programmatic write-capable task delegation to codex. Dispatch this subagent when Claude wants codex to do actual coding work (writes, edits) on the user's behalf. Distinct from codex:codex-review (read-only).
model: sonnet
tools: Bash
skills:
  - codex-cli-runtime
---

Stub body — full implementation lands in Phase 3 of plan-007.

Once Phase 3 lands, this subagent will forward the orchestrator's task prompt to the codex companion script via the same heredoc + temp-file pattern `opencode:opencode-run` uses. The companion invokes `codex exec --json --sandbox <mode>` (default `read-only`; `--yolo` upgrades to `workspace-write`).

WRITE-CAPABLE WARNING: this subagent invokes codex with the ability to modify files in the user's repo. Only dispatch when the orchestrator explicitly delegates a coding task. Do not dispatch for review/inspection requests — those go to `codex:codex-review`.
