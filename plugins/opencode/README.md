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
- v0.3.0 (plan 002, shipped) — review session continuity for `/opencode:review` and `/opencode:run` (resume the prior opencode session per `(plan-or-branch, role, model)` tuple); `--session-key` / `--reset` / `--no-session` flags; pure mkdir-EEXIST lock (manual-rm recovery for stranded locks; auto-reclaim queued for plan 005).
- v0.4.0 (this release, plan 003) — `--style adversarial` flag on `/opencode:review` for hostile-perspective critique; opt-in Stop-hook review gate (`/opencode:gate on|off|status`) that runs a review on every actionable Claude turn with smart-skip for read-only turns + fail-open recovery.
- v0.5.0 (plan 004) — macOS parity for `/opencode:cancel` PID-reuse defense + `--task-file` TOCTOU + `--task` stdin-as-prompt support.
- v0.6.0+ (plan 005) — `flock(2)`-backed serialization replacing best-effort CAS in `lib/jobs.mjs` + the mkdir-EEXIST session lock.

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
- opencode CLI ≥ 1.14, installed and on PATH (or set `OPENCODE_BIN` to its absolute path).
- A default `model` field in `~/.config/opencode/opencode.json`.
- Linux for full `/opencode:cancel` PID-reuse defenses (macOS uses best-effort kill — see Known limitations).

## Environment overrides (mostly for testing)

| Variable | Effect |
|---|---|
| `OPENCODE_BIN` | Override the opencode binary path. |
| `OPENCODE_CONFIG` | Override the config file path. |
| `OPENCODE_REPO_ROOT` | Override the working directory the companion script reviews. |
| `CLAUDE_PROJECT_DIR` | Override the project root used to resolve `<project>/.claudecode-buddy/`. Set automatically by Claude Code; tests override. |
| `OPENCODE_MODEL` | Override the model used by the `prompt` subcommand (the `review` and `run` subcommands use their own `--model` flag). |
| `OPENCODE_BUDDY_FORCE_INTERACTIVE=1` | Bypass the non-interactive `--yolo` guard in `runRun` (test-only). |
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

### From v0.3.0 (this release; tracked for plan 004+ polish)

- **No auto-reclamation of stranded session locks.** A dispatch that crashes without releasing the per-tuple `.lock` directory requires manual `rm -rf <path>.lock`. The error message on the next acquisition includes the exact recovery command. Auto-reclaim queued for plan 004 with proper `flock(2)` semantics. (See "Session continuity" → "Stranded locks" above.)
- **Capture fallback under same-cwd-different-tuple races.** When stderr capture fails (only happens if opencode's log format changes), the session-list-cwd-filtered fallback can pick the wrong session for parallel `/opencode:review` + `/opencode:run` dispatches. Stderr is the primary path precisely because it's deterministic per-process — this is a fallback-only edge case.
- **macOS case-insensitive realpath comparison** in `captureLatestSessionForCwd` is best-effort. Pathological mixed-case symlink chains are out of scope for v0.3.0.
- **Supervisor module-load gap.** Microsecond window between `spawn()` returning and the top-of-file `uncaughtException` handler registering — a thrown ESM import in that window would strand the lock. Static-imports-of-built-ins-only minimises this, but documented for transparency.

### From v0.2.0 (tracked for plan 004/005 polish)

- **macOS cancel** uses best-effort PID match (no `/proc/<pid>/cmdline`). If pid is recycled in the SIGKILL grace window, an unrelated process could be hit. The `pidIsOurSupervisor` Linux check verifies via cmdline; macOS support via `ps -o command=` is tracked for plan 004. The cancel command emits a `WARNING` line on non-Linux to surface this trade-off.
- **`--task-file` TOCTOU defense is Linux-only** (uses `/proc/self/fd/<N>` for fd-bound path resolution). macOS support deferred to plan 004.
- **CAS in `updateJob` is best-effort, not truly atomic** — read-check-write window is microseconds; under truly concurrent writers (supervisor close vs SessionEnd vs cancel), last-write-wins. Worst case: a misleading status (e.g., `session-ended` on a job that completed); recoverable via `<id>.events`. True flock serialization is plan 005 work.
- **ARG_MAX limit** for `--task` as positional CLI arg (>2MB on Linux; >256KB on macOS). Use `--task-file` for very long tasks. Stdin-as-prompt support tracked for plan 004.
- **Single-pass trailer parsing** — `/opencode:review` does not retry on malformed JSON trailers. Verdict becomes `needs-attention (parse error)` immediately.
