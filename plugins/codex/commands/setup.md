---
description: Check whether the local codex CLI is ready and a default model is configured
argument-hint: ''
allowed-tools: Bash(node:*)
---

This command's body lands in Phase 2 (per `docs/plans/007-codex-plugin-parity.md`).

Until Phase 2 lands, this is a stub:

```bash
echo "/codex:setup — stub. Phase 2 of plan-007 will fill the body."
```

After Phase 2:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" setup
```

Present the full command output to the user verbatim. Do not summarize. If the output indicates codex is not installed, do not auto-install — surface the install guidance from the script as-is. codex is distributed via `curl -fsSL https://codex.ai/install | bash` or `~/.codex/bin/codex` after running `codex update`; auto-installing would require executing a remote binary, which warrants explicit user consent.
