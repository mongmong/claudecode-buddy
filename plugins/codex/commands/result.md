---
description: Show the captured output of a codex background job by id
argument-hint: '<job-id>'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" result "$ARGUMENTS"
```

Return the script's stdout verbatim. Output: a header (status, exit code, timestamps) followed by the parsed assistant text from `<id>.stdout` (NOT the raw NDJSON `<id>.events`).

If output indicates the job is still running, suggest `/codex:status` to confirm liveness.
