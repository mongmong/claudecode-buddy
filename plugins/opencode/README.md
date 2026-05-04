# opencode plugin

Claude Code plugin that wraps the [opencode](https://opencode.ai) CLI as a third independent code-review and write-capable coding agent.

## What this gives you

- **`/opencode:review`** — code review of the working tree or branch diff. Prompts you to pick a model each invocation (skippable with `--model` in the args).
- **`/opencode:run`** — write-capable task delegation (foreground or `--background`). Defaults to honoring opencode's own permission prompts; `--yolo` opts into auto-approve. In non-interactive contexts (subagent, CI, piped stderr), `--yolo` is required.
- **`/opencode:status`** / **`/opencode:result`** / **`/opencode:cancel`** — background-job lifecycle.
- **`/opencode:setup`** — verify the opencode CLI is installed and a default model is configured.
- **`opencode:opencode-review` subagent** — programmatic review dispatch.
- **`opencode:opencode-run` subagent** — programmatic write-capable task dispatch.

## Phasing

- v0.1.0 (plan 000, shipped) — read-only review only.
- v0.2.0 (this release, plan 001) — write-capable run + background tasks + local install scripts.
- v0.3.0 (plan 002) — adversarial-review + optional Stop-hook review gate; macOS cancel support; flock-based serialization for SessionEnd vs supervisor races.

See `docs/specs/opencode-plugin.md` and `docs/plans/001-opencode-run-and-background.md` in the workspace for design and implementation details.

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

## Known limitations (v0.2.0)

Documented for transparency; tracked for plan 002 polish:

- **macOS cancel** uses best-effort PID match (no `/proc/<pid>/cmdline`). If pid is recycled in the SIGKILL grace window, an unrelated process could be hit. The `pidIsOurSupervisor` Linux check verifies via cmdline; macOS support via `ps -o command=` is tracked for plan 002. The cancel command emits a `WARNING` line on non-Linux to surface this trade-off.
- **`--task-file` TOCTOU defense is Linux-only** (uses `/proc/self/fd/<N>` for fd-bound path resolution). macOS support deferred to plan 002.
- **CAS in `updateJob` is best-effort, not truly atomic** — read-check-write window is microseconds; under truly concurrent writers (supervisor close vs SessionEnd vs cancel), last-write-wins. Worst case: a misleading status (e.g., `session-ended` on a job that completed); recoverable via `<id>.events`. True flock serialization is plan 002 work.
- **ARG_MAX limit** for `--task` as positional CLI arg (>2MB on Linux; >256KB on macOS). Use `--task-file` for very long tasks. Stdin-as-prompt support tracked for plan 002.
- **Single-pass trailer parsing** — `/opencode:review` does not retry on malformed JSON trailers. Verdict becomes `needs-attention (parse error)` immediately.
