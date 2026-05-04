---
name: opencode-cli-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# Opencode Runtime

Use this skill only inside the `opencode:opencode-review` subagent (and, in future plans, `opencode:opencode-rescue`).

Primary helper for free-form prompt forwarding (the subagent's main mode):
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" prompt --prompt-file <path>` — REQUIRED form for the subagent. The prompt body must be written to a temp file via a quoted-delimiter heredoc; never inline the prompt text into the bash command line. See `agents/opencode-review.md` for the exact pattern.

Secondary helper for git-diff convenience review (rarely used by the subagent — `/opencode:review` covers that):
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review "<flag-style args>"`

Other input modes for `prompt`:
- `... prompt <positional words>` — joined by space; only safe when the prompt is known to contain no shell metacharacters. The subagent never uses this; reserved for ad-hoc CLI testing.
- `--stdin` is explicitly **NOT supported in plan 000** (security review deferred — it would enable arbitrary file reads via shell redirection).

Execution rules:
- The review subagent is a forwarder, not an orchestrator. Its only job is to invoke ONE companion subcommand once and return that stdout unchanged.
- Prefer `prompt` for forwarded review requests from the orchestrator. The orchestrator constructs the full review prompt (including any references to specific files, focus questions, or expected output format).
- Use `review` only when the orchestrator explicitly says "review the working-tree diff" or "review the branch diff" without supplying its own prompt text.
- Do not call `setup` from the review subagent — `/opencode:setup` is a user-facing command.

Output:
- Return the stdout of the companion command verbatim.
- The orchestrator parses the trailing `verdict:` line for routing decisions; do not reformat or strip it.
- Do not paraphrase, summarize, or add commentary before or after it.
- If the Bash call fails or opencode cannot be invoked, return the script's stderr verbatim.

Trailer behavior — important contract difference between the two routes:
- `review` route: the prompt explicitly asks the model for a trailer. Missing trailer → `verdict: needs-attention (parse error)` is always printed.
- `prompt` route: the orchestrator may or may not have asked for a trailer. If a trailer is present, the script prints both the text and a parsed verdict line. If no trailer is present, the script prints the text only — no verdict line is synthesized. Orchestrators that need a verdict signal must include hybrid-output instructions in the prompt body (typically a fenced JSON block with `verdict` and `blockers`).
