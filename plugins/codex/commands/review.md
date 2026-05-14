---
description: Run a codex code review against local git state (foreground only in v1)
argument-hint: '[--scope auto|working-tree|branch] [--base <ref>] [--model <id>] [--variant <high|max|minimal>] [--style friendly|adversarial] [--session-key <name>] [--reset] [--no-session]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Stub body — full implementation lands in Phase 2 of plan-007.

For Phase 2 design, see `docs/plans/007-codex-plugin-parity.md` → Phase 2.

Once Phase 2 lands, this command will:
1. Run the model picker (analog of `/opencode:review`'s).
2. Invoke `codex exec --json` with the diff + review prompt template.
3. Parse the JSONL event stream (per Phase 1.5 gate 1 findings).
4. Capture the session UUID from the first-line `thread.started` event (per Phase 1.5 gate 2 findings).
5. Persist the UUID for session continuity (per Phase 1.5 gate 3 findings).
6. Emit the parsed assistant verdict text + a trailer line.

For now, this command is a stub:

```bash
echo "/codex:review — stub. Phase 2 of plan-007 will implement this."
```
