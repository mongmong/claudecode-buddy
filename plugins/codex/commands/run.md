---
description: Delegate a write-capable coding task to codex (foreground or --background)
argument-hint: '[--task <text> | --task-file <path>] [--model <id>] [--variant <high|max|minimal>] [--sandbox read-only|workspace-write|danger-full-access] [--yolo] [--background] [--session-key <name>] [--reset] [--no-session]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a write-capable task to codex through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command IS write-capable: codex MAY modify files in your repo (depending on the sandbox mode).
- Surface the companion's output verbatim. Do not interpret or summarize the work codex did.

Sandbox decision (per plan-007 Phase 1.5 gate 4 — `workspace-write` is silent-allow):
- **Default** (no `--yolo`, no explicit `--sandbox`): `--sandbox read-only`. Codex can read the repo but cannot write. Preserves opencode's "user consent before writes" property.
- **`--yolo`**: maps to `--sandbox workspace-write` — cwd-confined writes, no per-operation prompts.
- **Explicit `--sandbox danger-full-access`**: writes anywhere; requires user override (no shorthand). Reserved for trusted full-repo work.

Pre-flight (safety prompts):
1. **--yolo confirmation.** If `$ARGUMENTS` contains `--yolo`, use AskUserQuestion exactly once with the question: `"--yolo upgrades the codex sandbox from read-only to workspace-write (cwd-confined writes, no per-operation prompts). Confirm?"` Options: `Confirm and proceed` / `Cancel`. If the user picks Cancel, stop without invoking the companion.
2. **--sandbox danger-full-access confirmation.** If `$ARGUMENTS` contains `--sandbox danger-full-access`, AskUserQuestion: `"--sandbox danger-full-access lets codex write ANYWHERE on disk (not just the workspace). This is rarely needed. Confirm?"` Options: `Confirm and proceed` / `Cancel`.
3. **--background acknowledgement.** If `$ARGUMENTS` contains `--background`, no prompt — the user explicitly chose detached execution. Just remind them of `/codex:status <id>` for tracking.

Model selection (REQUIRED before invoking run):

Same flow as `/codex:review`. Skip if `$ARGUMENTS` already contains `--model <value>`.

1. List models: `node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" models`
2. AskUserQuestion with one option per model (default first, suffixed `(default)`). 4-option cap with `Other (specify model id)` if more.
3. Capture as `$CHOSEN_MODEL`. If empty after the picker, stop.

Execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" run --model "$CHOSEN_MODEL" "$ARGUMENTS"
```

If the user-supplied `--model` path was taken (skipping the picker), invoke WITHOUT the injected `--model`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" run "$ARGUMENTS"
```

Output handling:
- Return the script's stdout verbatim.
- For foreground runs, the output ends with a `Files changed:` summary derived from `git diff --stat` (with `--no-ext-diff` defense). Do not add additional summarization.
- For `--background` runs, the output is a one-line `Started job <id>` plus follow-up command hints. Surface verbatim.

Argument handling:
- Preserve the user's arguments exactly (apart from injecting the model picker's choice).
- Supported flags: `--task`, `--task-file`, `--model`, `--variant`, `--sandbox`, `--yolo`, `--background`, `--session-key`, `--reset`, `--no-session`. Unknown flags or unexpected positional args are rejected with exit 2 — surface the error verbatim.

Session continuity:
- By default, this command **resumes the prior codex session** scoped to `(plan-or-branch, role=run, model)`. Successive runs on the same plan/branch share the prior context.
- `--session-key <name>` to override the auto-derived key.
- `--reset` to discard the stored session UUID and start fresh.
- `--no-session` for a one-off detached task.

Reasoning effort:
- Pass `--variant <level>` to forward a model-specific reasoning effort (maps to `-c model_reasoning_effort=<level>`). Common values: `high`, `max`, `minimal`.
