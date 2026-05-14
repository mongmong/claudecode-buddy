---
description: Delegate a write-capable coding task to codex (foreground or --background)
argument-hint: '[--task <text> | --task-file <path>] [--model <id>] [--variant <high|max|minimal>] [--yolo] [--background] [--session-key <name>] [--reset] [--no-session]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Stub body — full implementation lands in Phase 3 of plan-007.

Sandbox decision (per Phase 1.5 gate 4 findings — `workspace-write` is silent-allow):
- Default (no `--yolo`): `--sandbox read-only` — preserves opencode's "user consent before writes" property.
- `--yolo` set: `--sandbox workspace-write` — cwd-confined writes; no per-operation prompts.
- Explicit `--sandbox danger-full-access`: writes anywhere; requires user override (no shorthand).

Once Phase 3 lands, this command will:
1. Model picker (skip if `--model` already in `$ARGUMENTS`).
2. `--yolo` confirmation prompt (parity with `/opencode:run`).
3. `--background` acknowledgement.
4. Invoke `codex exec --json --sandbox <decided-mode>` with the task + sandbox config.
5. Foreground: parse + print assistant text + `Files changed:` summary from `git diff --stat`.
6. Background: spawn supervisor; return `Started job <id>`.

For now, this command is a stub:

```bash
echo "/codex:run — stub. Phase 3 of plan-007 will implement this."
```
