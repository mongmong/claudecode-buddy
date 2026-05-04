---
description: Show active and recent opencode jobs in this repo
argument-hint: '[<job-id>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" status "$ARGUMENTS"`

If the user passed no job id: surface the markdown table of jobs verbatim.

If the user passed a `<job-id>`: surface the full JSON record verbatim.
