---
description: Run a codex code review against local git state
argument-hint: '[--scope auto|working-tree|branch] [--base <ref>] [--model <id>] [--variant <high|max|minimal>] [--style friendly|adversarial] [--session-key <name>] [--reset] [--no-session]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a codex review through the companion script.

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
- If the change set is non-trivial (more than ~10 files or unclear size), warn the user that a codex run is billable on whichever model you have configured. Use `AskUserQuestion` exactly once with two options:
  - `Run the review (Recommended)` (or just `Run the review` if size is unclear)
  - `Cancel`
- If the change set is empty, tell the user "nothing to review" and stop without invoking codex.

Model selection (REQUIRED before invoking review):

The user's codex config (`~/.codex/config.toml`) typically has a single default `model =` setting. The plugin's model picker offers the configured default plus a small list of well-known codex models. Always ask the user which model to use for THIS review, even if a default is configured. Skip the prompt only when the user already supplied `--model <id>` in `$ARGUMENTS`.

1. **Detect user-supplied --model in $ARGUMENTS.** If `$ARGUMENTS` contains a `--model <value>` token (look for the literal flag), skip the picker and jump to the Execution step.
2. **Otherwise, list available models:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" models
```

3. The script prints one model id per line, default first. If the output starts with "config not found" or otherwise looks like an error, surface it to the user verbatim and stop without invoking review.
4. **AskUserQuestion** with one option per listed model (default model first, suffixed with `(default)`). The AskUserQuestion UI in Claude Code supports up to 4 options per question. If the model list has 4 or fewer entries, present them all; if more than 4, present the first 3 plus a fourth option `Other (specify model id)`. If the user picks `Other`, prompt them with a follow-up free-text question for the exact model id. Question text: `"Which codex model should run this review?"`.
5. **Capture the user's choice as `$CHOSEN_MODEL`.** If for any reason `$CHOSEN_MODEL` is empty after the picker (user cancelled, validation failed twice, etc.), stop without invoking review and tell the user "model selection cancelled".

Execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" review --model "$CHOSEN_MODEL" "$ARGUMENTS"
```

If the user-supplied `--model` path was taken (step 1), invoke instead WITHOUT the injected `--model`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" review "$ARGUMENTS"
```

The companion's `parseReviewArgs` flat-maps `splitArgs` across every input token, so `["--model", "X", "--scope working-tree"]` (mixed multi-arg + quoted) parses correctly.

Output handling:
- Return the script's stdout verbatim.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Argument handling:
- Preserve the user's arguments exactly (apart from injecting the model picker's choice).
- The script accepts `--scope`, `--base`, `--model`, `--variant`, `--style`, `--session-key`, `--reset`, and `--no-session`. Unknown flags or unexpected positional arguments are rejected with exit 2 and a clear error message — surface that error to the user verbatim.

Adversarial review:
- Pass `--style adversarial` to use the hostile-reviewer system prompt (looks for ways the code is broken rather than reasons to approve). Default `--style friendly`.
- Pair an adversarial reviewer alongside the friendly one in plan-review or code-review pipelines for a stronger consensus.

Reasoning effort:
- Pass `--variant <level>` to select a model-specific reasoning effort. Codex maps this to `-c model_reasoning_effort=<level>` (TOML config override). Common values: `high`, `max`, `minimal` — pass-through; codex validates.

Session continuity:
- By default, this command **resumes the prior codex session** scoped to `(plan-or-branch, role=review, model)`. Codex's session UUIDs are captured from the first-line `thread.started` event and stored at `<project>/.claudecode-buddy/codex/sessions/<key>-<role>-<model>.session-id`.
- Pass `--session-key <name>` to override the auto-derived key.
- Pass `--reset` to discard the stored session UUID and start fresh.
- Pass `--no-session` for a one-off detached question.
