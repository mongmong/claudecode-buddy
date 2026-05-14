---
name: codex-cli-runtime
description: Internal helper contract for calling the buddy runtime from Claude Code (parity with opencode-cli-runtime)
---

Stub body — full implementation lands in Phase 2 of plan-007.

This skill describes how Claude Code agents should invoke the codex plugin's companion script (`scripts/buddy.mjs`). It's the codex analog of `opencode:opencode-cli-runtime`.

For now, see `plugins/opencode/skills/opencode-cli-runtime/SKILL.md` for the shared contract pattern. The codex version will adapt:
- `codex exec --json` instead of `opencode run --format json`.
- `--sandbox read-only|workspace-write|danger-full-access` instead of `--dangerously-skip-permissions` (boolean).
- `-c model_reasoning_effort=<level>` instead of `--variant <level>`.
- UUID session-ids instead of `ses_*`.
- `codex exec resume <UUID> [PROMPT]` instead of `--session <id>` flag.
