# Plan 005 — `--variant` flag + opencode binary auto-discovery (v0.5.0)

> **Note:** This plan was written retroactively because both changes were small / well-scoped (a flag addition + a runner-detection fallback) and didn't warrant a formal plan-write → 4-way plan-review → implement cycle.
> The plan file exists primarily to host the post-execution report and the 4-way code-review verdicts in the canonical location, per the workspace's review policy.
> Future small changes that bypass the plan-write step should still land their code review here, in `docs/plans/NNN-<topic>.md ## Code Review`.

## Goals

1. Expose opencode's `--variant <level>` flag through the plugin so users can request provider-specific reasoning effort (e.g. `high`, `max`, `minimal`) without changing models.
2. Make the plugin "just work" after a fresh `curl https://opencode.ai/install | bash` install: auto-discover the binary at common install locations when it's not on `PATH` and `OPENCODE_BIN` isn't set.

## Surface

### `--variant` (commit 1e6ea25)

- New flag accepted by `parseReviewArgs`, `parseRunArgs`, `parsePromptArgs`.
  Free-form string forwarded verbatim to opencode (provider-specific; plugin does not validate).
- Forwarded in argv after `--model` by `runReview`, `runRun` (foreground), `runRunBackground`, and `invokeOpencode`.
- `OPENCODE_VARIANT` env var fallback for the `prompt` subcommand only (mirrors `OPENCODE_MODEL`). Explicit flag wins over env.
- `parseRunArgs` duplicate-flag guard extended to `--variant`.
- Does NOT change the session-continuity tuple — same session can mix variant levels.
- Slash-command + subagent + README + CHANGELOG updates. Plugin + marketplace versions bumped 0.4.0 → 0.5.0.

### Auto-discovery (commit dbc3522)

- `lib/cli-detection.mjs` adds a third resolution step after `OPENCODE_BIN` and `PATH`:
  scan a documented list of well-known install locations and use the first existing + executable hit.
- Scan order (most-likely-correct first): `~/.opencode/bin/opencode`, `~/.local/bin/opencode`, `~/.bun/bin/opencode`, `~/.npm-global/bin/opencode`, `~/.npm/bin/opencode`, `/opt/homebrew/bin/opencode`, `/usr/local/bin/opencode`, `/usr/bin/opencode`.
- Only matches regular executable files (mode bit `0o111` set) — directories + non-executables at these paths are skipped.
- "Not installed" guidance enumerates every location checked + reminds about `OPENCODE_BIN`.
- Exports frozen `WELL_KNOWN_INSTALL_PATHS` for tests + introspection.

## Tests

- 10 new tests in `tests/opencode/variant.test.mjs` — forwarding via mock binary that records argv (review / run-foreground / run-background-via-supervisor / prompt), default-omission, missing-value rejection, duplicate-flag rejection, env-var fallback / precedence.
- 10 new tests in `tests/opencode/cli-detection.test.mjs` (file grew 3 → 13) — scan-fallback, scan-order, OPENCODE_BIN-wins, PATH-wins (hermetic sandbox + a defense-in-depth version-string variant), executable-bit gating via `accessSync(X_OK)`, directory rejection, guidance content, frozen export.
- New fixture `tests/opencode/fixtures/mock-opencode-record-args.mjs` records argv to `$OPENCODE_RECORD_ARGS_PATH`.

## Test counts

| Stage | Count |
|---|---|
| v0.4.0 baseline | 234 (231 pass, 3 e2e skipped) |
| + variant tests (commit `1e6ea25`) | 243 |
| + cli-detection scan tests (commit `dbc3522`) | 252 |
| + Codex round-1 fixes — added 1 background-run test, replaced 1 silently-no-op test with 2 hermetic ones (commit `fb5f83b`) | **257** total — **254 pass, 3 e2e skipped, 0 fail** |

## Plan Review

Skipped — both changes are small, well-scoped, and not "substantial" in the CLAUDE.md sense (flag addition + runner fallback).
The 4-way plan-review gate is reserved for plans that introduce new commands, runner refactors, or cross-cutting architectural change.

## Code Review

Per the v0.5.0+ workspace policy, four reviewers run in parallel:

| # | Reviewer | Model |
|---|---|---|
| 1 | Self-review (Opus 4.7) | claude-opus-4-7 |
| 2 | Codex | Codex default |
| 3 | DeepSeek V4 Flash (via opencode) | deepseek/deepseek-v4-flash |
| 4 | GLM 5.1 (via opencode) | volcengine-plan/glm-5.1 |

### \[self-opus\] — 2026-05-05 — approve (2 minor + 3 info, 0 blockers)

Read `git diff main...HEAD` (5 commits, 17 files, +818/-33) on Opus 4.7.

**Findings:**

1. **[minor — non-blocking]** `plugins/opencode/hooks/hooks.json:32` Stop timeout (1500s = 25m) equals the inner outer-Promise.race ceiling at `stop-review-gate-hook.mjs:21`. If Claude Code's per-hook kill-timer fires at the same instant as the outer race, the script's catch-handler cleanup could be `SIGKILL`-ed mid-log. Recommend bumping `hooks.json` to ~1530s to give 30s of clean-exit headroom over the inner outer ceiling. Fail-open semantics preserved either way (a killed hook → Claude Code falls through), so this is hardening rather than a bug.

2. **[minor — non-blocking]** `OPENCODE_VARIANT` env-var fallback only applies to the `prompt` subcommand (`buddy.mjs:runPrompt`), NOT to `review` or `run`. This mirrors the existing `OPENCODE_MODEL` pattern, but the README's "Reasoning effort" section doesn't explicitly call out the asymmetry — a user setting `OPENCODE_VARIANT` and expecting it to apply to `/opencode:review` would silently get the default. Minor doc clarity gap; resolution: add one sentence to the README's `OPENCODE_VARIANT` row or the "Reasoning effort" section saying "applies to the `prompt` subcommand only."

3. **[info]** `OPENCODE_BIN` set to a directory passes `existsSync(path)` in `resolveBinary`, so we return the dir → `execFileSync --version` fails → `broken: true`. Works correctly but goes through a slightly indirect path. Could short-circuit by adding the same `isExecutableFile` check on `OPENCODE_BIN`. Trade-off: stricter but adds a stat on the user-explicit-override path that previously didn't need one. Not a blocker — current behavior is correct, just not maximally diagnostic.

4. **[info]** `accessSync(X_OK)` semantics on Linux/macOS: tests the **real** uid/gid (not effective), which is what we want for "can this process exec the binary". Symlinks are followed (vs `lstatSync` which wouldn't), so a symlinked binary at a well-known path resolves correctly. Broken symlinks → `existsSync` returns false → skipped. ✓

5. **[info]** This PR's own 4-way review is going through partial bypass: the `opencode:opencode-review` subagent isn't loaded in the current Claude Code session, so DeepSeek + GLM are dispatched via the documented bash escape hatch (`opencode run --model X --dangerously-skip-permissions ...`). The plan file should record the bypass + the bash log paths (`/tmp/cb-review/{deepseek,glm}.{out,err}`) so the audit trail is complete. Will add when consolidating verdicts.

**Verdict: approve.** No correctness blockers. Two [minor] items recommended for follow-up (timeout-headroom hardening + README env-var-scope clarity); three [info] notes that don't require action.

### \[codex\] — 2026-05-05 — approve (4 minor, 0 blockers; all addressed in fb5f83b)

Codex was dispatched against the pre-fix branch (commit `4512774`) via `codex:codex-rescue` subagent.

**Findings (all `[MINOR]`, no `[OPEN]` blockers):**

1. `cli-detection.mjs:30` — `(mode & 0o111) !== 0` could pick a file executable by another user but not the calling process. Recommended `accessSync(X_OK)`.
2. `README.md:121` — install-paths list omitted `~/.npm/bin/opencode` (the code scans it; doc drift).
3. `cli-detection.test.mjs:162` — the "PATH wins over scan" test used `require()` inside an `.mjs` file, which throws `ERR_REQUIRE_ESM`. The throw was caught silently, the test no-opped without asserting anything.
4. `variant.test.mjs` — no background-run argv assertion for `--variant`. The supervisor argv spread is the riskiest call path; a future refactor that mishandled it would silently drop the flag.

**Resolution:** all four fixed in commit `fb5f83b`. New test count: 254/257 (was 252/255). The PATH-precedence test now uses a sandbox PATH directory with a fake binary so it runs hermetically without depending on a real opencode being installed; an additional defense-in-depth test uses distinct version strings to prove which binary was selected.

**Verdict: approve.**

### \[opencode:deepseek-v4-flash\] — 2026-05-05 — approve (4 doc-drift notes, 0 correctness blockers)

Dispatched against the post-fix branch (HEAD `fb5f83b`) via the bash escape hatch — the `opencode:opencode-review` subagent isn't loaded in the current Claude Code session, and the user authorized the documented `opencode run --model X --dangerously-skip-permissions ...` fallback to complete the 4-way gate.

**Findings (all non-blocking):**

1. **Correctness:** `--variant` forwarding verified across all 4 dispatch sites; supervisor argv spread carries it across the cross-process boundary; `cli-detection` precedence honored; `accessSync(X_OK)` semantics correct on Linux/macOS; coordinated timeout bump consistent.
2. **Hidden assumptions:** `HOME` unset/empty + symlinks + paths-with-spaces all handled.
3. **Test coverage gap (minor, pre-existing):** `parseReviewArgs` has no duplicate-flag guard for `--variant` (or any flag); `parseRunArgs` does. Pre-existing inconsistency, not a regression.
4. **Doc drift (4 items):** CHANGELOG test counts say "9+9" but actual is "10+10" (Codex round added 2 tests post-CHANGELOG); plan-005 has the same stale counts; README "Phasing" section v0.5.0 entry was stale (described as "macOS parity / --task-file / stdin-as-prompt" — old plan-005 scope before reclamation); README v0.3.0 entry references "auto-reclaim queued for plan 005" which is also stale.

**Resolution:** all 4 doc-drift items fixed in the same commit that records this verdict. Test count gap (`parseReviewArgs` duplicate guard) noted as non-blocking; out of scope for this PR.

**Verdict: approve** — once the doc fixes land.

### \[opencode:glm-5.1\] — 2026-05-05 — needs-attention (3 \[OPEN\], all doc-level; resolved in the same commit)

Dispatched against the post-fix branch (HEAD `fb5f83b`) via the bash escape hatch (same reason as DeepSeek above).

**Findings:**

1. **Correctness:** Same conclusions as DeepSeek + Codex. No correctness blockers across `--variant` plumbing, cli-detection precedence, `accessSync(X_OK)` semantics, supervisor-argv spread, or timeout coordination.
2. **Hidden assumptions:** `HOME` falsy + symlinks + spaces + TOCTOU all sound. Symlink edge cases (broken symlink, symlink-to-directory at well-known path) are untested but low risk.
3. **\[OPEN\] CHANGELOG test counts stale** — same as DeepSeek #4. Resolved in the same commit.
4. **\[OPEN\] CHANGELOG missing timeout-bump entry** — the 5m→20m / 15m→25m coordinated bump is user-facing (the Stop-hook gate can now block Claude Code's `Stop` event for up to 25 min, was 15) but wasn't documented in the v0.5.0 entry. **NEW finding GLM caught that DeepSeek didn't.** Resolved by adding a "Review timeout coordinated bump (USER-FACING)" entry to the v0.5.0 `### Changed` section.
5. **\[OPEN\] 4-way code review TBD slots** — plan-005's `## Code Review` section had 4 TBDs at GLM's review time. Resolved by this commit which fills all 4 slots and re-dispatches GLM.
6. **Test coverage observations (minor):** Same `parseReviewArgs`-no-duplicate-guard note as DeepSeek; suggests a negative test confirming `OPENCODE_VARIANT` does NOT apply to `review`/`run` (only `prompt`). Both noted, both out of scope for this PR.

**Verdict pre-fix: needs-attention.** All 3 `[OPEN]` items are doc-level; no correctness blockers. Re-dispatch on the post-doc-fix commit expected to flip the verdict to approve — captured below if/when it runs.

**Re-dispatch verdict (post-doc-fix, HEAD `eecf826`):** ✅ **approve.** GLM confirmed all 3 `[OPEN]` items as `[RESOLVED]`:
1. CHANGELOG test counts stale → resolved (10+10, 254 / 257).
2. CHANGELOG missing timeout-bump entry → resolved (full "Review timeout coordinated bump (USER-FACING)" entry under `### Changed`).
3. 4-way code review TBD slots → resolved (all four reviewer slots filled).

## Post-execution report

| Phase | Status | Commit |
|---|---|---|
| `--variant` flag implementation + tests + docs | ✅ shipped | `1e6ea25` |
| Auto-discovery + tests + docs | ✅ shipped | `dbc3522` |
| Plan file (this document) | ✅ shipped | `4512774` |
| Review timeout coordinated bump (5m→20m inner, 15m→25m outer) | ✅ shipped | `466aa0a` |
| Codex round-1 fixes (4 minor items) | ✅ shipped | `fb5f83b` |
| DeepSeek + GLM doc-drift fixes (CHANGELOG counts + timeout entry + plan ## Code Review verdicts) | ✅ shipped | `eecf826` |
| 4-way code review (all four ✅ approve after re-dispatch) | ✅ complete | this commit |

### What changed (file-level)

- `plugins/opencode/scripts/buddy.mjs` — three parsers + four dispatch sites, all gated on `args.variant`.
- `plugins/opencode/scripts/lib/invoke.mjs` — `invokeOpencode` accepts `variant` param, pushes `--variant` after `--model`.
- `plugins/opencode/scripts/lib/cli-detection.mjs` — full rewrite of resolution. Adds `WELL_KNOWN_PATHS`, `expandHome`, `isExecutableFile`, `scanWellKnownPaths`, `pathHasOpencode`, `buildGuidance` helpers.
- Slash commands (`commands/review.md`, `commands/run.md`) + subagents (`agents/opencode-review.md`, `agents/opencode-run.md`) — `--variant` documented in argument-hint, supported-flags list, and a "reasoning effort" section.
- `plugins/opencode/README.md` — `--variant` section + auto-discovery requirement update + `OPENCODE_VARIANT` env-var row.
- `plugins/opencode/CHANGELOG.md` — v0.5.0 entry.
- Plugin + marketplace versions bumped 0.4.0 → 0.5.0.

### Known limitations / explicit non-goals

- **Windows install paths** are not scanned. `~/.opencode/bin/` works on Windows (the official installer puts it there) but `%APPDATA%\opencode\bin\opencode.exe` and similar are not in `WELL_KNOWN_PATHS`. Out of scope for v0.5.0; the `OPENCODE_BIN` escape hatch covers the affected case.
- **Provider-specific variant validation** is intentionally absent. opencode forwards `--variant` to the provider unchanged; the provider may silently drop unknown variants. Documented in the plugin README.
- **Session-continuity tuple is unchanged.** A session that switched models mid-stream would already have to restart; mixing variant levels does NOT trigger that, by design (variant is "how hard to think", not "what model").
