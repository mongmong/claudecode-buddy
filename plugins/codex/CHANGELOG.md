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

### Full feature set (Phases 2-8 all shipped)

- `/codex:review` — code review of working-tree or branch diff. Flags: `--scope`, `--base`, `--model`, `--variant`, `--style friendly|adversarial`, `--session-key`, `--reset`, `--no-session`.
- `/codex:run` — write-capable task delegation. Default `--sandbox read-only`; `--yolo` upgrades to `--sandbox workspace-write` (cwd-confined); `--sandbox danger-full-access` requires explicit override. Foreground or `--background`.
- `/codex:rescue` — parity with openai-codex's command of the same name; dispatches the `codex-rescue` subagent (alias of `codex-review`).
- `/codex:status` / `/codex:result` / `/codex:cancel` — background-job lifecycle.
- `/codex:gate` — opt-in Stop-hook review gate.
- `/codex:setup` — verify codex CLI + default model.
- Subagents: `codex:codex-review`, `codex:codex-run`, `codex:codex-rescue` (literal-copy alias of `codex-review`).
- Hooks: SessionStart/SessionEnd orphan-job detection + Stop-hook gate (opt-in).
- Session continuity per `(plan-or-branch, role, model)` tuple via codex thread UUIDs (captured from first-line `thread.started` event per Phase 1.5 gate 2).
- `--variant <level>` for provider-specific reasoning effort (maps to `-c model_reasoning_effort=<level>`).
- All plan-006 critical-path safety defenses carried forward from day 1: `git diff --no-ext-diff` (closes RCE H1), fd-bound `--prompt-file`/`--task-file` (closes H2/M1 TOCTOU on Linux), two-layer SIGTERM in supervisor (closes H3), `pid-identity` injectable cmdline reader for macOS (closes C2/M2), `.catch` on top-level dispatches (closes C1), fail-open ESM ordering in hooks (closes H4), path-based containment FIRST on `--task-file` (round-1 macOS regression prevention).
- Test seams (parity with opencode's): `CODEX_BUDDY_TEST_THROW`, `CODEX_BUDDY_TEST_SLOW_IMPORT_MS`, `CODEX_BUDDY_TEST_PID_NEVER_OURS`.

### Sandbox semantic decision (per Phase 1.5 gate 4)

Codex's `--sandbox workspace-write` is silent-allow (no per-operation prompts). To preserve opencode's "user consent before writes" property:
- `/codex:run` default is `--sandbox read-only` — codex can read but not write.
- `--yolo` maps to `--sandbox workspace-write` — cwd-confined writes, no prompts.
- `--sandbox danger-full-access` requires explicit user override.

### Migration from openai-codex

See workspace `README.md` → "Migrating from openai-codex (third-party) to claudecode-buddy/codex" for the uninstall-first migration path.

### Test counts

- Phase 2: 17 codex-side tests.
- Phase 3: +13 (run/status/result/cancel + R11 macOS containment regression test).
- Phase 5: +5 (gate command).
- Phase 6: +4 (variant flag + reasoning-effort wire-up).
- Phase 8: +4 (cross-plugin-sync byte-equality assertions).
- **Total: ~43 codex-side tests + 4 workspace-level cross-sync tests.**
- Combined workspace suite: 327+ tests / 324+ pass / 3 e2e skipped / 0 fail.
