---
description: Toggle the opt-in Stop-hook review gate (off by default)
argument-hint: '[on|off|status]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Toggle the workspace-level Stop-hook review gate.

Raw slash-command argument: `$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" gate "$ARGUMENTS"
```

Surface the script's stdout verbatim. The script accepts `on`, `off`, `status` (default), and rejects anything else with exit 2.

When `gate on` enables the gate, every Claude Code `Stop` event will run an opencode review of the working-tree state. The gate fails open on review-system errors and smart-skips read-only turns (no git changes). See `/opencode:gate status` to confirm the current state.
