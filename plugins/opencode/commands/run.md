---
description: Delegate a write-capable coding task to opencode (foreground or --background)
argument-hint: '[--task <text> | --task-file <path>] [--model <provider/model>] [--yolo] [--background]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a write-capable task to opencode through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command IS write-capable: opencode may modify files in your repo (especially with --yolo).
- Surface the companion's output verbatim. Do not interpret or summarize the work opencode did.

Pre-flight (safety prompts):
1. **--yolo confirmation.** If `$ARGUMENTS` contains `--yolo`, use AskUserQuestion exactly once with the question: `"--yolo will pass --dangerously-skip-permissions to opencode. opencode will edit files in your repo without prompting. Confirm?"` Options: `Confirm and proceed` / `Cancel`. If the user picks Cancel, stop without invoking the companion.
2. **--background acknowledgement.** If `$ARGUMENTS` contains `--background`, no prompt — the user explicitly chose detached execution. Just remind them of `/opencode:status <id>` for tracking.
3. If neither --yolo nor --background, no pre-flight prompt — opencode's own permission system gates writes.

Model selection (REQUIRED before invoking run):

Same flow as `/opencode:review`. Skip if `$ARGUMENTS` already contains `--model <value>`.

1. List models: `node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" models`
2. AskUserQuestion with one option per model (default first, suffixed `(default)`). 4-option cap; if more, present the first 3 plus `Other (specify model id)` with a free-text follow-up validated against the captured listing.
3. Capture as `$CHOSEN_MODEL`. If empty after the picker, stop.

Execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" run --model "$CHOSEN_MODEL" "$ARGUMENTS"
```

If the user-supplied `--model` path was taken (skipping the picker), invoke instead WITHOUT the injected `--model`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" run "$ARGUMENTS"
```

Output handling:
- Return the script's stdout verbatim.
- For foreground runs, the output ends with a `Files changed:` summary derived from `git diff --stat`. Do not add additional summarization.
- For `--background` runs, the output is a one-line `Started job <id>` plus follow-up command hints. Surface verbatim.

Argument handling:
- Preserve the user's arguments exactly (apart from injecting the model picker's choice).
- Supported flags: `--task`, `--task-file`, `--model`, `--yolo`, `--background`. Unknown flags or unexpected positional args are rejected with exit 2 — surface the error verbatim.
