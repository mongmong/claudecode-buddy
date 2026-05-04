# opencode plugin

Claude Code plugin that wraps the [opencode](https://opencode.ai) CLI as a third independent code-review agent.

## What this gives you

- **`/opencode:review`** — code review of the working tree or branch diff using whichever LLM you have configured in `~/.config/opencode/opencode.json`. Prompts you to pick a model each invocation (skippable with `--model` in the args).
- **`/opencode:setup`** — verify the opencode CLI is installed and a default model is configured.
- **`opencode:opencode-review` subagent** — programmatic review dispatch via the `Agent` tool, used by orchestrators (e.g., the workspace's dual plan-review gate).

## Phasing

This plugin ships in phases. v0.1.0 (this release) is read-only review only. Future versions add:

- v0.2.0 — `/opencode:rescue` (write-capable), background tasks, `/opencode:status` / `/opencode:result` / `/opencode:cancel`.
- v0.3.0 — `/opencode:adversarial-review`, optional Stop-hook review gate.

See `docs/specs/opencode-plugin.md` and `docs/plans/000-opencode-plugin-v1-scaffold.md` in the workspace for design and implementation details.

## Output format

`/opencode:review` prints the model's Markdown findings followed by a parsed verdict line:

```
verdict: approve | needs-attention
blockers:
  - short blocker title
```

The verdict comes from a fenced JSON trailer block the model is asked to emit at the end of its review. If the model omits the trailer, the verdict defaults to `needs-attention (parse error)` and the parse error is printed.

## Requirements

- Node ≥ 18.18.
- opencode CLI ≥ 1.14, installed and on PATH (or set `OPENCODE_BIN` to its absolute path).
- A default `model` field in `~/.config/opencode/opencode.json`.

## Environment overrides (mostly for testing)

| Variable | Effect |
|---|---|
| `OPENCODE_BIN` | Override the opencode binary path. |
| `OPENCODE_CONFIG` | Override the config file path. |
| `OPENCODE_REPO_ROOT` | Override the working directory the companion script reviews. |
| `OPENCODE_MODEL` | Override the model used by the `prompt` subcommand (the `review` subcommand uses its own `--model` flag). |
| `OPENCODE_E2E=1` | Enable end-to-end tests against the real opencode CLI. |

## Known limitations (v0.1.0)

These are documented for transparency and tracked for plan 002 polish:

- **Non-UTF8 diff content** — diffs containing non-UTF8 bytes (e.g., binary files staged as text, mixed-encoding sources) may corrupt the prompt sent to opencode. The companion script does not transcode. Workaround: stage binaries via `.gitattributes` `binary` filter or exclude them with `--scope` (not yet supported beyond auto/working-tree/branch — track in plan 002).
- **PATH edge cases** — CLI detection follows the first match on PATH and does not handle dead symlinks, no-execute permission, or PATH entries with embedded colons in any clever way. If `opencode --version` fails for any of these reasons, the plugin reports "not installed" and the user falls back to `OPENCODE_BIN`.
- **Single-pass trailer parsing** — if the model omits or malforms the JSON trailer, the verdict becomes `needs-attention (parse error)` immediately. No retry. This trades best-effort recovery for predictable cost and latency.
- **Foreground only** — long opencode runs block the Claude Code session. A 5-minute timeout terminates hung runs. Background execution lands in plan 001.
