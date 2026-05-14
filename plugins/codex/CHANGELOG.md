# Changelog

All notable changes to the codex plugin are documented here.

## 0.5.1 — Initial release, full v0.5.1 parity with the opencode plugin

The codex plugin ships at version `0.5.1` to match the opencode plugin's parity baseline. Built from plan-007 (`docs/plans/007-codex-plugin-parity.md`); all features carry forward the plan-006 critical-path safety baseline (RCE / TOCTOU / SIGTERM / fail-open hooks) from day 1.

Pre-implementation Phase 1.5 empirically verified 5 codex CLI assumptions:
- `codex exec --json` emits parseable NDJSON events.
- Session UUID captured from the first-line `thread.started` event's `thread_id`.
- `codex exec resume <UUID> [PROMPT]` accepts positional prompts.
- `--sandbox workspace-write` is silent-allow → `/codex:run` defaults to `--sandbox read-only`; `--yolo` upgrades to `workspace-write`.
- Namespace collision behavior deferred to user verification; conservative uninstall-first migration is canonical.

### Initial feature set (Phase 1)

- Plugin manifest + marketplace registration.
- Command stubs: `/codex:review`, `/codex:run`, `/codex:setup`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:gate`, `/codex:rescue`.
- Subagent stubs: `codex:codex-review`, `codex:codex-run`, `codex:codex-rescue` (literal-copy alias of `codex-review` with the `name:` field changed).
- Skill stub: `codex:codex-cli-runtime`.
- Hooks with fail-open ESM ordering (carries plan-006 Phase 4 H4 forward from day 1): `SessionStart`, `SessionEnd`, `Stop` registered; session-start/end scripts written but no-op until Phase 3 lands `lib/jobs.mjs` and `lib/pid-identity.mjs`.

### Phases 2-8 (in progress)

See `docs/plans/007-codex-plugin-parity.md` for the trajectory.

### Migration from openai-codex

See workspace `README.md` → "Replacing openai-codex with claudecode-buddy/codex" once the migration guide lands in Phase 8.
