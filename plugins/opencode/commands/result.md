---
description: Show the stored final output for a finished opencode job
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" result "$ARGUMENTS"`

Surface the stored stdout verbatim. Do not summarize. The trailing `status: <state> (exit <code>)` line tells the user how the job finished.
