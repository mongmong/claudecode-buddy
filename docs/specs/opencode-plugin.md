# Spec — opencode plugin

Cross-cutting design spec for the `opencode` Claude Code plugin.
Referenced by execution plans `000-opencode-plugin-v1-scaffold.md` (read-only review) and the planned follow-on plans `001` (write-capable rescue + background tasks) and `002` (adversarial-review + hooks).

This spec captures the *architectural shape* of the plugin — components, interfaces, data flow, and conventions that hold across all phases.
Each phase's concrete file lists, testing matrix, and verification steps live in its execution plan.

## Why this plugin exists

The workspace's primary product is a three-model code-review consensus (Claude + Codex + opencode).
OpenAI's `codex` plugin already exists and gives Claude Code an ergonomic wrapper around the Codex CLI.
No equivalent published plugin wraps the [opencode](https://opencode.ai) CLI.
This plugin is the missing third leg of the consensus.

Since opencode runs *whichever LLM the user has configured*, the plugin gives the workspace a flexible third reviewer whose model can change over time without code changes here.

## Goals

- Mirror the codex plugin's UX and architecture so users familiar with `/codex:*` find `/opencode:*` immediately legible.
- Expose opencode as both an *interactive* surface (slash commands) and a *programmatic* surface (subagents Claude can dispatch).
- Be model-agnostic — defer model selection to the user's `~/.config/opencode/opencode.json`.
- Ship a full-fledged solution (review *and* write-capable rescue) over multiple phased plans, not a one-shot mega-PR.
- Provide a programmatic verdict signal (parsable JSON) so the workspace's dual-review gate can branch on "blockers vs no blockers" deterministically.

## Non-goals

- Not a wrapper around opencode's TUI mode (we use `opencode run`, the headless one-shot runner, exclusively).
- Not a marketplace listing in v1 — local-install only until the runner contract is stable.
- Not an opinionated model picker — the plugin does not embed a default model.
- Not a replacement for Claude as the primary coding agent — opencode is a *secondary* agent for review and selective rescue tasks.

## Architecture

### Components

```
plugins/opencode/
├── .claude-plugin/plugin.json     # Manifest
├── commands/                       # User-facing slash commands
├── agents/                         # Programmatic subagents (dispatched by Claude)
├── skills/                         # Internal helper contracts (user-invocable: false)
├── scripts/                        # Node companion runner — single source of truth for opencode invocation
├── schemas/                        # JSON schemas for structured output
├── README.md
└── CHANGELOG.md
```

The **companion script** (`scripts/buddy.mjs`, named per D-009; was `scripts/opencode-companion.mjs` until plan 001) is the single point of contact with the opencode CLI.
Slash commands and subagents are thin wrappers that invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/buddy.mjs" <subcommand> <args>` and return its stdout.
This concentrates all opencode-specific logic (prompt construction, output parsing, schema validation, error handling) in one auditable file. The codex plugin uses the equivalent `codex-companion.mjs`; we deliberately use a different name to avoid visual collision and to align with the workspace name.

### Slash commands vs. subagents

- **Slash commands** are the *user-facing* surface. Users type `/opencode:review`. Each command is a Markdown file with frontmatter (`description`, `argument-hint`, `allowed-tools`, `disable-model-invocation`) and a body that instructs Claude to invoke the companion script.
- **Subagents** are the *programmatic* surface. Claude (the orchestrator) dispatches them via the `Agent` tool with `subagent_type: "opencode:opencode-review"`. Subagents run in their own context, so verbose opencode output does not pollute the orchestrator's context window. The dual-review gate uses subagents, not raw `Bash(opencode run ...)` calls.
- **Internal skills** (`user-invocable: false`) document the runtime contract for subagents. A subagent's prompt references its skill rather than inlining the contract — this keeps subagent definitions terse and lets the runtime contract evolve without rewriting every subagent.

### Data flow — `/opencode:review` (git-diff convenience)

```
User: /opencode:review
  → Claude reads commands/review.md
  → Claude estimates diff size with `git diff --shortstat`
  → Claude invokes: node scripts/buddy.mjs review <args>
    → Companion script:
      1. Resolves repo root, base ref, scope
      2. Retrieves diff (staged + unstaged + untracked-from-disk for working-tree;
         <base>...HEAD for branch). All git calls use execFileSync (no shell).
         Errors propagate as invocation failures, not as silent empty diffs.
      3. Builds prompt: review framing + hybrid-output instructions + diff
      4. Spawns: opencode run --dangerously-skip-permissions --format json --dir <repo> "<prompt>"
         (with timeout, default 5 minutes)
      5. Streams JSON events from opencode stdout
      6. Extracts assistant text from `text`-typed events, grouping by messageID,
         concatenating part text in order. Final message wins.
      7. Locates the fenced ```json``` trailer block
      8. Validates trailer against schemas/review-trailer.schema.json (handwritten
         validator; additionalProperties false; non-empty blocker strings)
      9. Single-pass: no retry. On parse failure, surfaces parse error and treats
         verdict as "needs-attention (parse error)".
     10. Prints to stdout: opencode's full Markdown + a parsed verdict line
  → Claude returns stdout verbatim to user
```

### Data flow — `opencode:opencode-review` subagent (free-form passthrough)

```
Orchestrator Claude session
  → Agent({subagent_type: "opencode:opencode-review", prompt: "<focused review prompt>"})
    → Subagent reads opencode-cli-runtime skill
    → Subagent: writes prompt body to a temp file via heredoc with quoted delimiter
      (no Bash interpolation of prompt content), then one Bash call:
      `node scripts/buddy.mjs prompt --prompt-file /tmp/X`
      → Companion script:
        1. Reads prompt text from --prompt-file
        2. Spawns opencode run with the prompt text verbatim (with timeout)
        3. Extracts assistant text (same parsing as `review`)
        4. If a trailer block is present, parses and prints verdict line
        5. Otherwise prints raw text only — NO synthesized verdict line
    → Subagent removes temp file and returns stdout verbatim
  → Orchestrator parses the verdict line (if present) for routing decisions
```

The dual-review gate uses the *subagent* path (free-form) because it asks opencode to read specific plan/spec files and answer focused questions, not to review a git diff. The slash command uses the *review* path (git-diff convenience) because that's the typical user-interactive use case.

### Two routes through the companion script

The companion script exposes two execution subcommands plus the `setup` introspection subcommand:

- `review` — *git-diff convenience*. Resolves scope, retrieves the diff, builds a review prompt that explicitly asks the model for a hybrid-output trailer, invokes opencode, parses the trailer, prints Markdown + verdict. Powers the user-facing `/opencode:review` slash command. Because the prompt always asks for a trailer, missing trailer = `verdict: needs-attention (parse error)`.
- `prompt` — *free-form passthrough*. Accepts an arbitrary prompt text from the caller and forwards it to opencode unchanged. The caller's prompt determines whether a trailer is requested. Powers the `opencode:opencode-review` subagent, which orchestrators dispatch with focused review prompts about specific files (e.g., the dual plan-review gate asking opencode to review `docs/plans/000-foo.md` against `docs/specs/foo.md`). Input modes for `prompt` (in priority order): `--prompt-file <path>`, `--stdin`, or positional args. The subagent uses `--prompt-file` to avoid Bash interpolation of the prompt body.
- `setup` — diagnostics only.
- `models` — enumerates models from `~/.config/opencode/opencode.json`. Used by `/opencode:review` to populate its per-invocation model picker (an `AskUserQuestion` prompt that surfaces the user's available models so they pick one explicitly per review). Reads-only; no opencode CLI invocation.

Both `review` and `prompt` share the same low-level `lib/invoke.mjs` and the same opencode CLI flags (`--dangerously-skip-permissions --format json`). They differ in trailer behavior:

- `review` always emits a `verdict:` line (parsed verdict on success, parse-error verdict on failure).
- `prompt` emits a `verdict:` line ONLY when a trailer is present in the model's response. If no trailer is present, the script prints raw text only — no synthesized verdict line. This matches the orchestrator's contract: "if I asked for a trailer, give me a verdict; if I didn't, just give me the text."

### Hybrid output convention

opencode's review output is **Markdown findings** followed by **a single fenced JSON trailer block**:

````markdown
## Findings

1. **Missing null check** (`src/foo.ts:42`) — Critical. `user.email` may be undefined when …
2. **Schema drift** (`schemas/order.schema.json:18`) — Should fix. The `quantity` field …

## Recommendation

The implementation is mostly sound but blocks on finding #1.

```json
{
  "verdict": "needs-attention",
  "blockers": [
    "Missing null check in src/foo.ts:42 will crash on guest checkout"
  ]
}
```
````

The schema is intentionally tiny (`verdict: "approve" | "needs-attention"`, `blockers: string[]`) so smaller models behind opencode (e.g., glm-4.7) can produce it reliably. Rich finding metadata stays in the Markdown — only the gate-relevant signal goes in the JSON.

The schema lives at `plugins/opencode/schemas/review-trailer.schema.json`. The companion script validates against it with a small handwritten validator (decision recorded in plan 000) — no `ajv` dependency in v1.

#### Why a minimal trailer schema (vs. codex's richer review-output.schema.json)?

Codex's `review-output.schema.json` requires `summary`, `findings[]` (each with `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`), and `next_steps[]`. That richer schema is appropriate for codex because it runs OpenAI's frontier models which reliably produce strict nested JSON.

opencode runs *whichever* model the user has configured — frontier or otherwise. A 200B-class model behind opencode often produces excellent prose review but unreliable nested JSON. Forcing a deeper schema would either fail parse-validation frequently (eroding trust in the verdict signal) or require complex retry logic that doubles latency and cost.

The hybrid format keeps the rich findings in Markdown (where any model excels) and reserves the JSON trailer for the *single* signal the dual-review gate needs: "are there blockers, yes/no, with titles." This is the smallest schema that satisfies the gate's machine-readable requirement, and it works across the full range of opencode-supported models.

If a future plan determines that a richer schema is needed for some other use case, it can be added as a separate trailer (e.g., a `findings` block alongside the `verdict` block) without breaking existing consumers.

#### Single-pass parse, no retry in v1

If the model omits or malforms the trailer, the companion script does *not* re-prompt. Instead, it emits a `verdict: needs-attention (parse error)` line and surfaces the underlying parse error. Rationale: a retry doubles latency and cost; in practice, when a model omits the trailer once it tends to omit it again. v1 prefers a fast, predictable failure mode over best-effort recovery. Plan 002 may revisit this if telemetry shows trailer omission is common with mainstream opencode-configured models.

## Capability rollout

### Plan 000 — read-only review (this scaffold)

| Component | Surface |
|---|---|
| `/opencode:review` | Slash command, foreground only, working-tree or branch scope |
| `/opencode:setup` | Slash command, structural CLI + config check |
| `opencode:opencode-review` | Subagent for programmatic review dispatch |
| `opencode-cli-runtime` | Internal skill, runtime contract |
| `scripts/opencode-companion.mjs` | Subcommands: `review`, `prompt`, `setup`, `models` (renamed to `scripts/buddy.mjs` in plan 001 per D-009) |
| `schemas/review-trailer.schema.json` | Hybrid-output trailer schema |
| Tests at workspace `tests/opencode/` | `node:test` smoke + parse coverage |
| `CLAUDE.md` rewrite | Drop "review-only" framing; recast as phased full-fledged plugin |

Permissions: review commands always pass `--dangerously-skip-permissions` to opencode (read-only, runs in trusted local repo).

### Plan 001 — write-capable run + background tasks + local install

Adds the second major capability slice: opencode can now *write code* in the user's repo, not just review it. Background-job machinery becomes necessary because write-capable tasks can run long enough to block the Claude Code session if foreground-only.

Surface:

| Component | Surface |
|---|---|
| `/opencode:run` | Slash command, foreground or `--background`, write-capable |
| `/opencode:status` | Slash command, lists active and recent jobs in the repo |
| `/opencode:result` | Slash command, shows stored final output for a finished job |
| `/opencode:cancel` | Slash command, kills an in-flight background job |
| `opencode:opencode-run` | Subagent for programmatic write-capable dispatch |
| `scripts/buddy.mjs` | Renamed from `opencode-companion.mjs`. Adds subcommands: `run`, `status`, `result`, `cancel` |
| `scripts/lib/jobs.mjs` | New utility for job CRUD (create, load, update, list, cancel) |
| `hooks/hooks.json` + handlers | New `SessionStart` and `SessionEnd` hooks for orphan detection |
| `<project>/.claudecode-buddy/opencode/jobs/<id>.json` | New runtime state location (per D-008) |
| `scripts/install-local.sh`, `scripts/uninstall-local.sh` | Workspace-level scripts for symlink-based local install |
| `.gitignore` | Adds `.claudecode-buddy/` |

Naming: the slash command and subagent use `run` (not `rescue`) — opencode is a *primary* delegation target for the user, not a "Claude got stuck, opencode rescue us" fallback. The verb matches the underlying CLI (`opencode run ...`).

#### Permission posture (--yolo opt-in)

Write-capable opencode runs in a user's repo are a real footgun if auto-approved. The plugin defaults to honoring opencode's own permission prompts (which block on each write/exec). Users opt into auto-approve with `--yolo`:

- `/opencode:run "fix the bug"` → opencode prompts before each write; slash command surfaces prompts to the user.
- `/opencode:run --yolo "fix the bug"` → companion passes `--dangerously-skip-permissions` to opencode; opencode writes without prompting.

For the `opencode:opencode-run` subagent, the orchestrator must explicitly include `--yolo` in the bash command for auto-approve. Otherwise opencode prompts will block the subagent and surface as stderr/timeout.

Mirrors how `sudo`, `rm -i` vs `rm -f`, etc. work — safe by default, opt-in to skip safeguards.

#### Background-job state and lifecycle

Background jobs persist state to `<project>/.claudecode-buddy/opencode/jobs/<job-id>.json`. The directory `<project>/.claudecode-buddy/` is the *workspace convention* for plugin runtime state — future plugins (e.g., a hypothetical `aider` plugin) write to `<project>/.claudecode-buddy/<plugin-name>/...`. Recorded as architecture decision D-008.

Each job record:

```json
{
  "id": "job_<timestamp>_<random>",
  "kind": "run" | "review",
  "model": "provider/model-id",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601 | null",
  "status": "running" | "completed" | "cancelled" | "failed" | "session-ended",
  "pid": 12345,
  "exit_code": 0 | null,
  "stdout_path": "<absolute path to <project>/.claudecode-buddy/opencode/jobs/<id>.stdout>",
  "stderr_path": "<absolute path to <project>/.claudecode-buddy/opencode/jobs/<id>.stderr>",
  "events_path": "<absolute path to <project>/.claudecode-buddy/opencode/jobs/<id>.events>",
  "summary": "first line of opencode output (for status table)"
}
```

Hooks for cross-session orphan detection:

- `SessionStart` — scans `jobs/` for entries with `status: "running"` whose pid is no longer alive (or whose status was marked `session-ended` by a prior SessionEnd). Prints a one-line orphan summary so the user can decide to `result`/`cancel`/ignore.
- `SessionEnd` — marks all `status: "running"` jobs as `status: "session-ended"`. Distinguishes "was actually still running when the session ended" from "abandoned mid-flight".

The `Stop` hook (codex uses it for the optional review gate) is *not* implemented in plan 001. Deferred to plan 002 since it conflates "session ending" with "review gate" — codex coupled them; we don't have to.

#### Output for `/opencode:run`

Free-form Markdown only — no JSON trailer. A write-capable task's "verdict" is "did opencode finish, and what files changed?", not a binary approve/needs-attention. The user reads the prose and runs `git diff` to see changes. The orchestrator (when dispatching the subagent programmatically) can also `git diff` after the subagent returns — no schema needed for that.

This differs from `review` (which has a hybrid trailer because the dual-review gate needs a programmatic verdict signal). Keeping `run`'s output unstructured matches codex's `task` behavior and avoids forcing structured output through models that may not produce it reliably for write-capable workflows.

#### Local install

Plan 001 ships `scripts/install-local.sh` (workspace-level, not plugin-level) that symlinks `plugins/opencode/` into `~/.claude/plugins/marketplaces/claudecode-buddy-local/plugins/opencode/`, creating the local marketplace dir and a `marketplace.json` matching the openai-codex shape (constructed safely via Node, no jq dependency). Idempotent — re-running upgrades the symlink. Companion `uninstall-local.sh` removes the symlink. The marketplace is named `claudecode-buddy-local` (not the generic `local`) to avoid namespace collisions with other workspaces' local marketplaces.

This unblocks dogfooding: after install, the `opencode:opencode-review` and `opencode:opencode-run` subagents and `/opencode:*` slash commands become available in Claude Code without needing a published marketplace. Marketplace publishing is deferred to a later plan.

#### Companion runtime entry point: `buddy.mjs`

Plan 001 renames `plugins/opencode/scripts/opencode-companion.mjs` to `plugins/opencode/scripts/buddy.mjs` (D-009). Future plugins follow the same convention: each plugin's runtime entry point is `scripts/buddy.mjs`. Reasons:

- Aligns with the workspace name (`claudecode-buddy`) and the new state-dir convention (`.claudecode-buddy/`).
- Reduces visual collision with codex's `codex-companion.mjs` for users who have both plugins open.
- Generic file name + parent directory (`plugins/<name>/scripts/buddy.mjs`) reads cleanly and the parent dir disambiguates in editor quick-open.

Trade-off: two plugins with identically-named `buddy.mjs` files. Acceptable; the parent dir is always present in any reasonable navigation context.

### Plan 002 — adversarial-review + hooks (placeholder)

Adds:

- `/opencode:adversarial-review` — review reframed as challenging the *approach*, accepts free-form focus text.
- Optional `Stop` hook implementing an end-of-session review gate (off by default; toggled via `/opencode:setup --enable-review-gate`).
- Polish: better error messages, retry tuning, marketplace-prep cleanup.

### Plan 003 and beyond — placeholder

Candidate work, not yet committed:

- Marketplace publishing (`.claude-plugin/marketplace.json` at workspace root, version pinning, release docs).
- Multi-model dispatch (run the same review against multiple opencode-configured models in parallel).
- Integration with the workspace's eventual code-review automation (e.g., GitHub PR comment posting).
- Telemetry / cost tracking for opencode runs.

## Testing strategy

The test harness lives at workspace root (`tests/`), not per-plugin, so future plugins reuse it.
`node:test` runner — built into Node, no external test deps.

Three test tiers:

1. **Unit** — pure functions inside `scripts/lib/*.mjs` (prompt construction, JSON trailer extraction, schema validation, scope resolution, model listing, job CRUD). No subprocess. Always run in CI.
2. **Integration with mock opencode** — companion script invoked as a subprocess, with `OPENCODE_BIN` overridden to point at a fixture script that prints canned responses. Exercises the full pipeline minus the real CLI. Always run in CI.
3. **End-to-end with real opencode** — companion script invoked against a real `opencode run` call with a tiny prompt and the cheapest configured model. Gated behind `OPENCODE_E2E=1` env var. Run locally before each PR; not in CI until provider creds are available.

Coverage target: every public function, every branch, every error path. The plan file enumerates specific test cases per file.

## Conventions and constraints

- Markdown formatting in commands, agents, skills, and docs uses **semantic line breaks** (one sentence per line).
- All `*.md` plugin files have YAML frontmatter matching Claude Code's expected schema (see reference codex plugin).
- Exit-code semantics: the companion script uses `process.exit(0)` for *all runtime conditions* — successful review, blockers found, missing binary, git error, opencode invocation failure, parse error. The verdict and any error guidance are routed via stdout (slash commands and the subagent forward stdout verbatim, then the orchestrator parses the trailing `verdict:` line). The only non-zero exit code is `2` for argument-parse errors (e.g., a `prompt` subcommand invoked with no prompt text). This contract trades a richer exit-code vocabulary for a single, predictable rule that downstream consumers do not have to special-case.
- No secrets in any committed file. opencode credentials live in `~/.config/opencode/opencode.json`; the plugin never reads or modifies that file directly except in `setup` (read-only checks).
- The companion script never auto-installs opencode. `setup` surfaces install guidance only.

## Open questions deferred to plan 000

- Subagent name: `opencode:opencode-review` vs. just `opencode:review`. The codex plugin uses `codex:codex-rescue` (redundant prefix); mirroring that gives `opencode:opencode-review`. Resolve in plan 000.
- Do we keep `HANDOFF.md` as a recurring per-session convention or retire it as a one-shot bootstrap doc? Resolve in plan 000.
- Whether to depend on `ajv` for schema validation or hand-roll a tiny validator. Resolve in plan 000.
