---
description: Cancel a running codex background job by id (sends SIGTERM, supervisor releases the lock)
argument-hint: '<job-id>'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" cancel "$ARGUMENTS"
```

The companion sends SIGTERM to the supervisor's process group; the supervisor's SIGTERM handler (two-layer per plan-006 Phase 5a) releases the session lock and marks the job `cancelled` before exit.

PID-reuse defense (per plan-006 Phase 5b): `pidIsOurSupervisor` verifies the target PID's cmdline contains `buddy-supervisor:<jobId>` before signaling. On macOS this uses `ps -o command= -p <pid>` (codex parity with opencode's plan-006 closure). If the PID is no longer our supervisor (recycled or exited), the job is just marked `cancelled` without sending a signal.

Return the script's stdout verbatim.
