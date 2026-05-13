# opencode plugin

Claude Code plugin that wraps the [opencode](https://opencode.ai) CLI as a third independent code-review and write-capable coding agent.

## Install

See the workspace [`README.md`](../../README.md#install) for marketplace registration. Once registered:

```
/plugin install opencode@claudecode-buddy
```

then restart Claude Code.

## What this gives you

- **`/opencode:review`** — code review of the working tree or branch diff. Prompts you to pick a model each invocation (skippable with `--model` in the args).
- **`/opencode:run`** — write-capable task delegation (foreground or `--background`). Defaults to honoring opencode's own permission prompts; `--yolo` opts into auto-approve. In non-interactive contexts (subagent, CI, piped stderr), `--yolo` is required.
- **`/opencode:status`** / **`/opencode:result`** / **`/opencode:cancel`** — background-job lifecycle.
- **`/opencode:setup`** — verify the opencode CLI is installed and a default model is configured.
- **`opencode:opencode-review` subagent** — programmatic review dispatch.
- **`opencode:opencode-run` subagent** — programmatic write-capable task dispatch.

## Phasing

- v0.1.0 (plan 000, shipped) — read-only review only.
- v0.2.0 (plan 001, shipped) — write-capable run + background tasks. (Local install scripts shipped here too but were retired in plan 004 — see workspace README + D-012.)
- v0.3.0 (plan 002, shipped) — review session continuity for `/opencode:review` and `/opencode:run` (resume the prior opencode session per `(plan-or-branch, role, model)` tuple); `--session-key` / `--reset` / `--no-session` flags; pure mkdir-EEXIST lock (manual-rm recovery for stranded locks; auto-reclaim queued for a future plan with proper `flock(2)` semantics).
- v0.4.0 (plan 003, shipped) — `--style adversarial` flag on `/opencode:review` for hostile-perspective critique; opt-in Stop-hook review gate (`/opencode:gate on|off|status`) that runs a review on every actionable Claude turn with smart-skip for read-only turns + fail-open recovery.
- v0.5.0 (plan 005, shipped) — `--variant <level>` flag on `/opencode:review`, `/opencode:run`, the `prompt` subcommand, and both subagents for provider-specific reasoning effort (e.g. `high` / `max` / `minimal` — opencode forwards verbatim); automatic opencode binary discovery scanning common install locations when `OPENCODE_BIN` is unset and `opencode` isn't on `PATH`; coordinated review-timeout bump (5 min → 20 min inner, 15 min → 25 min outer Stop-hook ceiling).
- v0.5.1 (plan 006, this release) — critical-path safety patch from 4-way bug audit: `git diff --no-ext-diff` everywhere (closes RCE via untrusted repo's `diff.external`); fd-bound `--prompt-file` + untracked-file reads (closes Linux symlink-swap TOCTOU); `.catch()` on top-level dispatches; session hooks fail-open ESM ordering; cancel correctness (supervisor SIGTERM handler releases the lock; macOS `pidIsOurSupervisor` via `ps -o command=`; orphan detection uses cmdline check). See CHANGELOG for the full list.
- v0.6.0+ (future plans, queued) — H5 (flock-backed CAS) + H6 (lock-handoff window) + H7 (exit-code-on-failure across 33 sites) + H8 (timeout process-group rework) for plan-007; M3-M10 + L1-L11 polish for plan-008; macOS F_GETPATH-based fd-bound TOCTOU defense for plan-009+; stdin-as-prompt support, auto-reclaim of stranded session locks.

See `docs/specs/opencode-plugin.md`, `docs/plans/001-opencode-run-and-background.md`, and `docs/plans/002-review-session-continuity.md` in the workspace for design and implementation details.

## Adversarial review (v0.4.0+)

`/opencode:review` accepts `--style <friendly|adversarial>`. Default is `friendly` (the v0.3.0 behavior — looks for issues, approves when sound). `--style adversarial` switches to a hostile-reviewer perspective: assumes the code is broken in ways the friendly reviewer missed, hunts for edge cases, race conditions, hidden assumptions, and silent failures.

```bash
/opencode:review --style adversarial --model deepseek/deepseek-v4-pro
```

- Adversarial reviews run under a separate session-continuity tuple (`role=review-adversarial`), so the adversarial reviewer's history doesn't pollute the friendly reviewer's. Two parallel session histories per `(plan-or-branch, model)` is intentional.
- Pair with friendly review for stronger consensus: in plan-review or code-review pipelines, run both perspectives and consolidate findings.
- Prompt template at `prompts/adversarial-review.md` — edit to tune the adversarial framing for your codebase.

## Stop-hook review gate (v0.4.0+, opt-in)

Optional safety net that auto-runs a review on every Claude Code `Stop` event. Default OFF.

```bash
/opencode:gate on       # enable
/opencode:gate off      # disable
/opencode:gate status   # check current state
```

When ON: every actionable turn (where the working tree has changes) triggers a review of the diff + the assistant's last message. Verdict `needs-attention` blocks Claude's stop with the findings; `approve` passes through silently.

**Smart-skip behavior** (no review runs in these cases):
- Working tree is clean — `git status --porcelain` returns empty (read-only conversation turns).
- Only changes are under `.claudecode-buddy/` — the dispatcher's own session-id writes during plan/code review work (avoids reviewing the reviewer's session state).
- Git binary missing or wedged (`.git/index.lock` contention, etc.) — skip with stderr log; don't run a review against broken git.

**Cases where the gate runs:**
- Working tree has changes outside `.claudecode-buddy/` — the dominant case.
- Non-git workspace where `.git/` is missing — the gate runs WITHOUT a git-state filter (the reviewer falls back to Read/Glob/Grep tools to inspect the file system). Note: in non-git workspaces, the gate fires on every actionable Stop with no skip heuristic — opt out via `/opencode:gate off` if you don't want this overhead.

**Fail-open semantics:** if the review system itself errors (binary missing, model API down, trailer parse failure), the hook logs a warning to stderr and lets Claude proceed. Better to occasionally let through a bad turn than to permanently strand the user when the review system breaks.

**Threat model:** this is an advisory development gate, NOT a security control. For genuine security gating, use a CI-level enforcement.

**Cost:** every actionable turn → one extra opencode invocation. Recommended only for projects/sessions where the safety net is worth the latency + token cost.

## Session continuity (v0.3.0+)

`/opencode:review` and `/opencode:run` automatically resume the prior opencode session for `(plan-or-branch, role, model)`, so successive dispatches build on each other's reasoning instead of starting fresh.

**Key derivation** (rule-based, no LLM in the dispatch path):
- Branch matches `feature/plan-NNN-*` → key = `plan-NNN`.
- Otherwise in a git repo → key = `branch-<sanitised-branch-name>`.
- Non-git → key = `scratch`.

**Storage:** session-ids live at `<project>/.claudecode-buddy/opencode/sessions/<key>-<role>-<model>.session-id` (gitignored per D-008).

**Flags:**
- `--session-key <name>` — override the rule (e.g., `--session-key auth-refactor` for ad-hoc work on `main`).
- `--reset` — discard the stored session-id and start fresh (recovery for confused sessions).
- `--no-session` — skip reuse for THIS call without deletion (one-off detached question).

`--reset` and `--no-session` are mutually exclusive.

**Session-id durability:** opencode may garbage-collect inactive sessions on its own schedule. The dispatcher's pre-flight verification handles this gracefully — a stored id that no longer exists triggers a fresh session on the next call. Project moves can also invalidate stored ids; in that case `--reset` is the manual recovery path.

**Privacy:** session-ids stored under `.claudecode-buddy/` are gitignored and never committed. Treat them as you would chat history — anyone with the id and an authenticated opencode binary can resume the conversation. Don't paste them into pastebins/PRs.

**Disk-space growth:** v0.3.0 does NOT auto-prune. Each tuple uses ~30 bytes; 1000 unique tuples ≈ 30 KB. For very long-running projects you can manually `rm -rf .claudecode-buddy/opencode/sessions/<glob>`. Auto-prune queued for plan 004+.

**Stranded locks:** if a dispatch crashes without releasing its lock, the next dispatch fails with `locked: another opencode dispatch holds the session lock at <path>` and prints the manual recovery command. v0.3.0 deliberately does not auto-reclaim — proper `flock(2)`-backed locks ship in plan 004.

**`--session-key` for ad-hoc work on `main`:** the default `branch-main` key is coarse (all topics share one session). For frequent ad-hoc reviews on `main`, use `--session-key <brief-topic>` to scope per-topic.

**In-flight v0.2.0 background jobs:** supervisors spawned BEFORE upgrading to v0.3.0 continue with the old argv signature loaded at spawn time and don't write session-ids. New supervisors use the new argv shape and persist sessions normally. No coordination needed.

## Output format

`/opencode:review` prints the model's Markdown findings followed by a parsed verdict line:

```
verdict: approve | needs-attention
blockers:
  - short blocker title
```

`/opencode:run` (foreground) prints opencode's free-form Markdown response followed by a `Files changed:` summary derived from `git diff --stat`.

`/opencode:run --background` prints `Started job <id>` and exits immediately. Use `/opencode:status` and `/opencode:result <id>` to track progress.

## Requirements

- Node ≥ 18.18.
- opencode CLI ≥ 1.14. The plugin finds it via (in order): `OPENCODE_BIN` env var → `opencode` on `PATH` → an automatic scan of common install locations (`~/.opencode/bin/opencode` — the official installer's path — `~/.local/bin/`, `~/.bun/bin/`, `~/.npm-global/bin/`, `~/.npm/bin/`, `/opt/homebrew/bin/`, `/usr/local/bin/`, `/usr/bin/`). If your install is in a non-standard location, set `OPENCODE_BIN` to the absolute binary path.
- A default `model` field in `~/.config/opencode/opencode.json`.
- Linux for full `/opencode:cancel` PID-reuse defenses (macOS uses best-effort kill — see Known limitations).

## Reasoning effort (v0.5.0+)

`/opencode:review` and `/opencode:run` (and the `opencode:opencode-review` / `opencode:opencode-run` subagents) accept `--variant <level>`. The flag forwards opencode's `--variant` argument verbatim to the underlying provider — opencode documents `high`, `max`, and `minimal` as common values, but the exact set is provider-specific. Examples:

```bash
/opencode:review --variant max --model deepseek/deepseek-v4-pro
/opencode:run --variant minimal --task "tweak this comment"
```

- The flag is **provider-specific reasoning effort**, not a model selector. Pair it with `--model` when you want both pinned.
- Not all providers honor `--variant`; check your provider's docs. Unsupported values are silently dropped by some providers.
- `--variant` does NOT change the session-continuity tuple (key still `(plan-or-branch, role, model)`), so you can mix variant levels across rounds of the same session.
- The `prompt` subcommand also reads `OPENCODE_VARIANT` from the environment when `--variant` is not passed (useful for setting a default in CI).

## Environment overrides (mostly for testing)

| Variable | Effect |
|---|---|
| `OPENCODE_BIN` | Override the opencode binary path. |
| `OPENCODE_CONFIG` | Override the config file path. |
| `OPENCODE_REPO_ROOT` | Override the working directory the companion script reviews. |
| `CLAUDE_PROJECT_DIR` | Override the project root used to resolve `<project>/.claudecode-buddy/`. Set automatically by Claude Code; tests override. |
| `OPENCODE_MODEL` | Override the model used by the `prompt` subcommand (the `review` and `run` subcommands use their own `--model` flag). |
| `OPENCODE_VARIANT` | Override the reasoning-effort variant used by the `prompt` subcommand when `--variant` isn't passed. |
| `OPENCODE_BUDDY_FORCE_INTERACTIVE=1` | Bypass the non-interactive `--yolo` guard in `runRun` (test-only). |
| `OPENCODE_BUDDY_TEST_THROW=<funcName>` | Trigger a throw at the top of `runReview` / `runPrompt` / `runRun` (buddy.mjs) or the dynamic-import block of the session hooks (`hookLoad`). Exercises the top-level `.catch()` (Phase 3, v0.5.1) + the fail-open hook handlers (Phase 4, v0.5.1) in tests. Exact match required; production never activates. |
| `OPENCODE_BUDDY_TEST_SLOW_IMPORT_MS=N` | Force an N-ms delay before `supervisor.mjs`'s dynamic imports resolve. Used by the Phase 5a test that exercises the pre-import branch of the SIGTERM handler (v0.5.1). Test-only. |
| `OPENCODE_BUDDY_TEST_PID_NEVER_OURS=1` | Force `pidIsOurSupervisor` to return `false` regardless of platform, simulating the PID-reuse scenario in `runCancel` tests (v0.5.1). Test-only. |
| `OPENCODE_E2E=1` | Enable end-to-end tests against the real opencode CLI. |

## Background-job state

Background `/opencode:run --background` jobs persist state to `<project>/.claudecode-buddy/opencode/jobs/<id>.json` (gitignored). Per-job:

- `<id>.json` — record (kind, model, status, pid, pgid, exit_code, paths).
- `<id>.stdout` — parsed assistant text (NOT raw NDJSON).
- `<id>.stderr` — opencode's stderr stream.
- `<id>.events` — raw NDJSON event stream (for debugging).
- `<id>.supervisor-error` — written if the supervisor itself crashed.

Hooks (`SessionStart`, `SessionEnd`) detect orphaned jobs across session boundaries.

## Known limitations

### Closed in v0.5.1 (plan-006 — see CHANGELOG for details)

- ~~`git diff` RCE via `diff.external` on untrusted repos~~ — **closed (H1).** All 6 call sites now pass `--no-ext-diff --no-textconv`.
- ~~`--prompt-file` symlink-swap TOCTOU on Linux~~ — **closed (H2).** Now fd-bound via the new `openFdBound` primitive; resolves `/proc/self/fd/<N>` against the allowed dir.
- ~~`scope.mjs` untracked-file lstat/read race~~ — **closed (M1).** Uses `openFdBound` with `O_NOFOLLOW` (Linux + macOS); symlinks rejected at the kernel level.
- ~~Cancel strands the session lock~~ — **closed (H3).** Supervisor.mjs now has a two-layer SIGTERM handler that releases the lock both pre- and post-dynamic-import.
- ~~macOS cancel can SIGTERM a recycled PID~~ — **closed (C2).** `pidIsOurSupervisor` now uses `ps -o command=` on darwin via the extracted `lib/pid-identity.mjs` helper.
- ~~Orphan detection trusts any live PID~~ — **closed (M2).** Session-start uses `pidIsOurSupervisor` (cmdline + jobId check) — PID-reuse correctly classified as orphan.
- ~~Session hooks fail closed on module-load errors~~ — **closed (H4).** Both hooks now match `stop-review-gate-hook.mjs`'s fail-open ESM ordering.
- ~~Top-level async dispatches lack `.catch`~~ — **closed (C1).** Future refactor that introduces a throw won't crash Node with unhandled-rejection exit 1; runs through the labeled `.catch` handler with exit 2.

### Still open (queued for plan-007 / plan-008)

- **macOS `--prompt-file` / `--task-file` symlink-swap TOCTOU** — `openFdBound`'s `fdResolvedPath` is `null` on macOS (no `/proc/self/fd/`); the path-based `isUnderAllowedDir` check is the only defense, retaining the prior window. `F_GETPATH`-based defense via native binding queued for plan-009+.
- **PID-title race window (~10-50ms).** Between `spawn()` and `process.title = "buddy-supervisor:<jobId>"`, the OS sees the process as `node`. A cancel dispatched in this window sees PID alive but `pidIsOurSupervisor` returns `false` → cancel reports "not our supervisor"; user must retry. Strictly better than the prior macOS behavior; documented for retry expectations.
- **H5 — `updateJob` CAS is best-effort, not truly atomic.** Read-check-write window is microseconds; concurrent writers can interleave. Worst case: misleading status; recoverable via `<id>.events`. Proper `flock(2)` queued for plan-007.
- **H6 — lock-handoff window between `spawn()` and `"spawn"` event** in the parent dispatcher. Narrow window; requires parent-side `uncaughtException` handler. Plan-007.
- **H7 — 33 subcommand exit-0-on-failure sites.** `$?` is 0 even when the subcommand errored. CI/script consumers see false success. Audit + tests queued for plan-007a.
- **H8 — timeout kills only direct opencode child.** Provider-spawned grandchildren orphan after SIGTERM. Process-group rework queued for plan-007.
- **Capture fallback under same-cwd-different-tuple races.** When stderr capture fails (only happens if opencode's log format changes), the session-list-cwd-filtered fallback can pick the wrong session for parallel dispatches. Stderr is the primary path precisely because it's deterministic per-process — this is a fallback-only edge case.
- **macOS case-insensitive realpath comparison** in `captureLatestSessionForCwd` is best-effort.
- **Supervisor module-load gap on uncaughtException** — narrowed by Phase 5a (SIGTERM handler now at top, before imports), but `uncaughtException` itself doesn't fire on signals. Documented for transparency.
- **ARG_MAX limit** for `--task` as positional CLI arg (>2MB on Linux; >256KB on macOS). Use `--task-file` for very long tasks. Stdin-as-prompt support tracked for a future plan.
- **Single-pass trailer parsing** — `/opencode:review` does not retry on malformed JSON trailers. Verdict becomes `needs-attention (parse error)` immediately.
