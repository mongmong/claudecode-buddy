---
description: Check whether the local codex CLI is ready and a default model is configured
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" setup
```

Present the full command output to the user verbatim. Do not summarize.

If the output indicates codex is not installed, do not auto-install — surface the install guidance from the script as-is. codex is typically distributed via OpenAI's installer (or `npm install -g @openai/codex` depending on your distribution) and lands at `~/.codex/bin/codex`. Auto-installing would require downloading and executing a remote binary, which warrants explicit user consent rather than a one-line prompt.

If the output indicates the config is missing or has no default `model =` field in `~/.codex/config.toml`, surface that to the user with the script's guidance line.
