---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the codex rescue subagent
argument-hint: '<rescue prompt text>'
allowed-tools: Task
---

Stub body — full implementation lands in Phase 2 of plan-007 (parity with the openai-codex plugin's `/codex:rescue` slash command).

Once Phase 2 lands, this command dispatches the `codex:codex-rescue` subagent with the user's prompt as the agent's task. `codex-rescue` is a literal-copy alias of `codex-review` (per plan-007 R6), so the rescue body and review body share the same dispatch path.

For now, this command is a stub:

```bash
echo "/codex:rescue — stub. Phase 2 of plan-007 will wire this to the codex-rescue subagent."
```
