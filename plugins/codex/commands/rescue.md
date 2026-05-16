---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the codex rescue subagent (parity with the openai-codex /codex:rescue command)
argument-hint: '<rescue prompt text> [--model <id>] [--variant <high|max|minimal>]'
disable-model-invocation: true
allowed-tools: Task
---

This command dispatches the `codex:codex-rescue` subagent with the user's prompt as the agent's task. Parity with the openai-codex plugin's `/codex:rescue` command.

`codex-rescue` is a literal-copy alias of `codex-review` (per plan-007 R6 — the only difference between `agents/codex-rescue.md` and `agents/codex-review.md` is the file-level `name:` field). So the rescue body and review body share the same dispatch path: invoke `codex exec --json --sandbox read-only` via the companion script with the user's prompt + the configured model.

Forwarding rules:

- Pass the full `$ARGUMENTS` text as the subagent's prompt — strip nothing, paraphrase nothing.
- Use the `Task` tool to dispatch `subagent_type: "codex:codex-rescue"`. If that name isn't recognized in this Claude Code session (e.g., the plugin's subagents haven't loaded yet), fall back to `codex:codex-review` — they resolve to the same body.
- Surface the subagent's stdout verbatim. The trailing `verdict:` line (`approve` or `needs-attention`) is the orchestrator-readable summary; do not reformat it.
- If the subagent isn't loaded at all (cold start), fall back to a direct companion invocation:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" prompt "$ARGUMENTS"
  ```

When to use `/codex:rescue` vs `/codex:review`:
- `/codex:review` is the canonical entry point for diff-based code review with structured input (`--scope`, `--base`, `--style adversarial`, session continuity, model picker).
- `/codex:rescue` is for free-form investigation / follow-up / "look at this and tell me what's going on" prompts where the user supplies a prose question without a structured review request.

Both end up calling `codex exec --json --sandbox read-only` under the hood. The semantic distinction is which kind of question you're asking, not which underlying mechanism runs.
