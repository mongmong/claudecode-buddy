---
description: Run an opencode code review against local git state (foreground only in v1)
argument-hint: '[--scope auto|working-tree|branch] [--base <ref>] [--model <provider/model>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an opencode review through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the script's output verbatim to the user.

Pre-flight (size estimation):
- Inspect `git status --short --untracked-files=all`.
- Inspect `git diff --shortstat --cached` and `git diff --shortstat`.
- For branch scope, also inspect `git diff --shortstat <base>...HEAD`.
- If the change set is non-trivial (more than ~10 files or unclear size), warn the user that an opencode run is billable on whichever provider they have configured. Use `AskUserQuestion` exactly once with two options:
  - `Run the review (Recommended)` (or just `Run the review` if size is unclear)
  - `Cancel`
- If the change set is empty, tell the user "nothing to review" and stop without invoking opencode.

Model selection (REQUIRED before invoking review):

The user's opencode config typically defines multiple models with different cost / latency / quality characteristics. Always ask the user which model to use for THIS review, even if they have a default configured. Skip the prompt only when the user already supplied `--model <provider/model>` in `$ARGUMENTS`.

1. **Detect user-supplied --model in $ARGUMENTS.** If `$ARGUMENTS` contains a `--model <value>` token (look for the literal flag), skip the picker and jump to the Execution step.
2. **Otherwise, list available models:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" models
```

3. The script prints one `provider/model-id` per line, default first. If the output starts with "config not found" or otherwise looks like an error (no `/` separator on any line), surface it to the user verbatim and stop without invoking review.
4. **AskUserQuestion** with one option per listed model (default model first, suffixed with `(default)`). The AskUserQuestion UI in Claude Code supports up to 4 options per question. If the model list has 4 or fewer entries, present them all; if more than 4, present the first 3 plus a fourth option `Other (specify model id)`. If the user picks `Other`, prompt them with a follow-up free-text question for the exact `provider/model-id`. **Validate the typed value against the model list captured in step 2** (no need to re-run `companion models` — the listing is in your context); if the typed value doesn't match any listed model, repeat the picker once and then bail out. Question text: `"Which opencode model should run this review?"`.
5. **Capture the user's choice as `$CHOSEN_MODEL`.** If for any reason `$CHOSEN_MODEL` is empty after the picker (user cancelled, validation failed twice, etc.), stop without invoking review and tell the user "model selection cancelled".

Execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" review --model "$CHOSEN_MODEL" "$ARGUMENTS"
```

If the user-supplied `--model` path was taken (step 1), invoke instead WITHOUT the injected `--model`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" review "$ARGUMENTS"
```

The companion's `parseReviewArgs` flat-maps `splitArgs` across every input token, so `["--model", "X", "--scope working-tree"]` (mixed multi-arg + quoted) parses correctly. Last-occurrence wins on duplicate flags.

Output handling:
- Return the script's stdout verbatim.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Argument handling:
- Preserve the user's arguments exactly (apart from injecting the model picker's choice).
- The script accepts `--scope`, `--base`, and `--model`. Unknown flags or unexpected positional arguments are rejected with exit 2 and a clear error message — surface that error to the user verbatim.
