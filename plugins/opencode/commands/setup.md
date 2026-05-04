---
description: Check whether the local opencode CLI is ready and a default model is configured
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup
```

Present the full command output to the user verbatim. Do not summarize.

If the output indicates opencode is not installed, do not auto-install — surface the install guidance from the script as-is. opencode is distributed as a binary via `curl -fsSL https://opencode.ai/install | bash`, not via npm; auto-installing would require downloading and executing a remote binary, which warrants explicit user consent rather than a one-line prompt.

If the output indicates the config is missing or has no default model, surface that to the user with the script's guidance line.
