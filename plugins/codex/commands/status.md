---
description: List codex background jobs (running, completed, cancelled, session-ended, failed)
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" status
```

Return the script's stdout verbatim. Each line: `<job-id>  <status>[ alive|dead]  <kind>  <model>  started=<iso>  elapsed=<human>  <summary>`.

If output is `(no codex jobs)`, tell the user there are no jobs to display.
