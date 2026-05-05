# Plan 004 — Installable from GitHub (retire local-symlink workaround)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the opencode plugin installable from GitHub via Claude Code's standard marketplace mechanism, treating dogfooding as the regular-user path. No more `scripts/install-local.sh` symlink workaround — both regular users and developers go through the same install flow (filesystem-source for dev checkouts, GitHub-source for end users).

**Architecture:** add a single top-level `.claude-plugin/marketplace.json` at the repo root (sibling of `plugins/`). Claude Code reads this manifest from either a GitHub-source or filesystem-source marketplace registration. The `install-local.sh` + symlink + auto-generated marketplace.json gymnastics become unnecessary because the workspace itself IS now the marketplace. Removing the local-install path also forces real-environment testing (the user's reasoning: a custom-symlink workaround can mask environment issues that real users would hit).

**Plan number:** 004 (next sequential after plan 003 v0.4.0).
**Plan number reshuffle:** the plan-003 follow-up notes earmarked plan 004 = macOS parity and plan 005 = flock(2). This plan reclaims plan 004 for the GitHub-installable work; macOS parity shifts to plan 005, flock(2) to plan 006. README/CHANGELOG updates in Phase 3 reflect the renumber.
**Target plugin version:** v0.4.0 unchanged (this is a distribution-mechanism change, not a plugin behavior change). Marketplace metadata gets `version: "0.1.0"` matching codex's convention (the marketplace tracks its own version separate from plugins).

---

## Phases

| # | Component | Files |
|---|---|---|
| 1 | Top-level `.claude-plugin/marketplace.json` | `.claude-plugin/marketplace.json` (new) |
| 2 | Retire install scripts + README rewrite (atomic, single commit per round-1 review) | `scripts/install-local.sh` (delete), `scripts/uninstall-local.sh` (delete), `plugins/opencode/README.md` |
| 3 | D-012 + CHANGELOG entry + post-execution report | `docs/architecture/decisions.md`, `plugins/opencode/CHANGELOG.md`, `docs/plans/004-github-installable.md` |

---

## Phase 1 — Top-level marketplace.json

**Files:**
- Create: `.claude-plugin/marketplace.json`

### Schema (matches codex's marketplace structure)

```json
{
  "name": "claudecode-buddy",
  "owner": {
    "name": "claudecode-buddy"
  },
  "metadata": {
    "description": "Plugins for using third-party coding/review CLIs from inside Claude Code. Currently ships the opencode plugin.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "opencode",
      "description": "Use opencode from Claude Code to review code with whichever LLM you have configured. Adversarial-style review and an opt-in Stop-hook review gate ship in v0.4.0.",
      "version": "0.4.0",
      "author": {
        "name": "claudecode-buddy"
      },
      "source": "./plugins/opencode"
    }
  ]
}
```

### Tasks

- [ ] **Step 1: Create `.claude-plugin/marketplace.json`** with the JSON above (escape JSON correctly — no shell-interpolation hazards because we're writing literal JSON).

- [ ] **Step 2: Spike-verify the manifest is well-formed.**

```bash
node -e "JSON.parse(require('node:fs').readFileSync('.claude-plugin/marketplace.json', 'utf8'))"
```

Expected: silent exit 0.

- [ ] **Step 2b: Add a version-sync test** (per round-1 review SF #2 from both reviewers — guard against marketplace.json's `plugins[0].version` drifting from `plugins/opencode/.claude-plugin/plugin.json:version` on future plugin bumps).

`tests/marketplace-version-sync.test.mjs` (new file):

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("marketplace.json plugins[].version matches each plugin's plugin.json version", () => {
  const marketplace = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8"));
  for (const entry of marketplace.plugins) {
    const pluginManifest = JSON.parse(
      readFileSync(`plugins/${entry.name}/.claude-plugin/plugin.json`, "utf8"),
    );
    assert.equal(
      entry.version,
      pluginManifest.version,
      `marketplace.json plugins[${entry.name}].version (${entry.version}) ` +
      `must match plugins/${entry.name}/.claude-plugin/plugin.json:version ` +
      `(${pluginManifest.version}). Bump both when releasing.`,
    );
  }
});
```

Run: `node --test tests/marketplace-version-sync.test.mjs` — expected pass.

Future plugin version bumps must update both files; this test enforces it.

- [ ] **Step 3: Spike-verify Claude Code can register a filesystem-source marketplace pointing at the workspace** (operator validation, not automatable; per round-1 review the GitHub-source equivalent can only be operator-validated AFTER this PR merges to main and the marketplace.json is publicly fetchable). For the filesystem-source check during plan execution: edit `~/.claude/settings.json` to add:

```json
"extraKnownMarketplaces": {
  "claudecode-buddy": {
    "source": {
      "source": "filesystem",
      "path": "/home/chris/workshop/claudecode-buddy"
    }
  }
}
```

(or whichever local checkout path), then restart Claude Code and confirm `/plugin install opencode@claudecode-buddy` works (or settings.json `enabledPlugins["opencode@claudecode-buddy"] = true`). **This step is operator-validation, not a unit test** — it cannot be automated without a Claude Code test harness. Document the verification in the post-execution report.

- [ ] **Step 4: Post-merge operator validation (logged in post-execution report).** After this PR merges to main, the GitHub-source install path becomes possible to test. Validate by:

1. On a clean Claude Code state (or revert the existing `extraKnownMarketplaces["claudecode-buddy-local"]` entry first): run `/plugin marketplace add mongmong/claudecode-buddy` (or the canonical Claude Code command).
2. Run `/plugin install opencode@claudecode-buddy`.
3. Restart Claude Code; verify `/opencode:setup`, `/opencode:review`, `/opencode:run`, `/opencode:status`, `/opencode:result`, `/opencode:cancel`, `/opencode:gate` all appear in the slash-command picker.

Log the result in the post-execution report (Phase 3).

- [ ] **Step 5: Commit Phase 1**

```bash
git add .claude-plugin/marketplace.json tests/marketplace-version-sync.test.mjs
git commit -m "feat: top-level marketplace.json + version-sync test"
```

---

## Phase 2 — Retire install scripts + README rewrite (atomic per round-1 review)

**Files:**
- Delete: `scripts/install-local.sh`
- Delete: `scripts/uninstall-local.sh`
- Modify: `plugins/opencode/README.md` (the user-facing install section)
- Maybe-modify: top-level `README.md` if it exists; check first.

Per round-1 review (codex + deepseek both flagged): merging the deletion + docs-rewrite into one commit avoids an intermediate state where scripts are gone but docs still reference them. A user pulling main between separate phases would see "missing scripts + stale README" and be confused.

The new flow makes both scripts obsolete:

- The symlink `~/.claude/plugins/marketplaces/claudecode-buddy-local/plugins/opencode → workspace/plugins/opencode` was a workaround because the workspace had no top-level marketplace.json. With Phase 1 landed, Claude Code can register the workspace directly as a filesystem-source marketplace; the symlink + auto-generated marketplace.json stops being necessary.
- The auto-write of `~/.claude/plugins/marketplaces/claudecode-buddy-local/.claude-plugin/marketplace.json` from a Node heredoc was the fragile part — it didn't update `~/.claude/settings.json`'s `extraKnownMarketplaces`, leaving the install half-done (the user couldn't actually see the plugin's commands without a manual settings.json edit). The new flow has the user (or dev) do the settings.json edit directly OR use Claude Code's `/plugin` command — one explicit step, no surprise.

The cleanup of any existing symlink the script previously created (under `~/.claude/plugins/marketplaces/claudecode-buddy-local/`) is left to the user — it's harmless (the symlink still resolves; Claude Code just isn't reading from there anymore). Document the manual cleanup in the README's migration note.

### Install section content

```markdown
## Install

The plugin lives in this repo as a marketplace plugin. Two install paths — both first-class, no special-case scripts:

### From GitHub (regular users)

1. In Claude Code, run `/plugin marketplace add mongmong/claudecode-buddy` (or whatever the canonical command is — Claude Code's UI walks you through it).
2. `/plugin install opencode@claudecode-buddy`.
3. Restart Claude Code.

Equivalent settings.json snippet (if you prefer hand-editing):

```json
{
  "extraKnownMarketplaces": {
    "claudecode-buddy": {
      "source": {
        "source": "github",
        "repo": "mongmong/claudecode-buddy"
      }
    }
  },
  "enabledPlugins": {
    "opencode@claudecode-buddy": true
  }
}
```

### From a local checkout (developers / dogfooders)

Use the same `extraKnownMarketplaces` mechanism, just with a filesystem source:

```json
{
  "extraKnownMarketplaces": {
    "claudecode-buddy": {
      "source": {
        "source": "filesystem",
        "path": "/path/to/your/checkout/of/claudecode-buddy"
      }
    }
  },
  "enabledPlugins": {
    "opencode@claudecode-buddy": true
  }
}
```

Restart Claude Code. The plugin reloads from your checkout on every Claude Code restart, so a `git pull` + restart is enough to pick up changes.

**Why no `install-local.sh` anymore:** prior versions shipped a symlink + auto-generated marketplace.json script for local development. It was a workaround for not having a top-level marketplace.json; now that the workspace IS its own marketplace, the workaround is gone. Treating dogfooding as the same install path real users use forces real-environment testing — a custom-symlink workaround can mask environment issues that real users hit.

### Migrating from a previous local install

If you previously ran `bash scripts/install-local.sh`, you have a stale symlink at `~/.claude/plugins/marketplaces/claudecode-buddy-local/`. To clean up:

```bash
rm -rf ~/.claude/plugins/marketplaces/claudecode-buddy-local
```

Then follow the install instructions above to register the new `claudecode-buddy` marketplace.
```

### Tasks

- [ ] **Step 1: Read the current install section** in `plugins/opencode/README.md` to identify what's being replaced.

- [ ] **Step 2: Rewrite the install section** with the content above.

- [ ] **Step 3: Check for any remaining references to `install-local.sh` or `uninstall-local.sh`** in the README or other docs (`grep -rn "install-local\|uninstall-local" .`) and remove or update them.

- [ ] **Step 4: Delete the two scripts** (atomic with the docs change per round-1 review):

```bash
git rm scripts/install-local.sh scripts/uninstall-local.sh
```

- [ ] **Step 5: Commit Phase 2 (single atomic commit covering both deletion and docs rewrite).**

```bash
git add plugins/opencode/README.md
git commit -m "chore+docs: retire install-local.sh + rewrite install section (atomic)

Workspace is now self-publishing via top-level .claude-plugin/marketplace.json
(plan 004 Phase 1). Both deletions + the docs rewrite land in a single commit
to avoid an intermediate state where scripts are gone but docs still reference
them (per round-1 review)."
```

---

## Phase 3 — D-012 + CHANGELOG + post-execution report

**Files:**
- Modify: `docs/architecture/decisions.md`
- Modify: `plugins/opencode/CHANGELOG.md`
- Modify: `docs/plans/004-github-installable.md` (this file — append post-execution report)

### D-012 (architecture decision)

```markdown
## D-012 — Plugin distribution: top-level marketplace.json, no local-install script

**Decided in:** plan 004 (`docs/plans/004-github-installable.md`).

The repo root contains `.claude-plugin/marketplace.json`, listing every plugin under `plugins/` (currently just `opencode`). Claude Code consumes this manifest from either a GitHub source (regular users: `extraKnownMarketplaces["claudecode-buddy"].source = {source: "github", repo: "mongmong/claudecode-buddy"}`) or a filesystem source (developers point at their local checkout). Both paths reach the same manifest, so dogfooding uses the same install mechanism real users use.

Why: prior versions shipped `scripts/install-local.sh`, which symlinked the plugin into a synthetic `~/.claude/plugins/marketplaces/claudecode-buddy-local/` directory and auto-generated a marketplace.json there. The script didn't register the marketplace in `~/.claude/settings.json`, so users still had to manually edit settings to actually enable the plugin — the install was half-done. Worse, the symlink + auto-marketplace approach diverged from the real-user install path, which masks environment issues a regular user would hit.

The new approach: workspace IS its own marketplace (top-level marketplace.json). One install path, dogfooded by the same mechanism real users use.

Plan 004 deletes `scripts/install-local.sh` and `scripts/uninstall-local.sh`.

**Version coordination:** the plugin version lives in TWO places — `plugins/opencode/.claude-plugin/plugin.json:version` AND `.claude-plugin/marketplace.json:plugins[*].version`. When releasing a new plugin version, both files must be updated. `tests/marketplace-version-sync.test.mjs` enforces this — the test fails if the two values drift, surfacing the mismatch in CI before a release ships with a stale marketplace manifest.
```

### CHANGELOG entry

This is a **distribution-mechanism change**, not a plugin behavior change. The plugin itself stays at v0.4.0; the marketplace gets a version bump. Add a new top-level CHANGELOG section since the existing CHANGELOG is plugin-scoped:

```markdown
### 0.4.0 — distribution change (mid-release infrastructure)

`.claude-plugin/marketplace.json` added at the repo root; `scripts/install-local.sh` and `scripts/uninstall-local.sh` deleted. Plugin behavior unchanged from the v0.4.0 release. See `docs/architecture/decisions.md` D-012 for the rationale and `plugins/opencode/README.md` for the new install instructions.

If you previously ran `bash scripts/install-local.sh`, see the README's "Migrating from a previous local install" section.
```

### Tasks

- [ ] **Step 1: Add D-012 to `docs/architecture/decisions.md`** (after D-011).

- [ ] **Step 2: Append the distribution-change note to `plugins/opencode/CHANGELOG.md`** under the existing `## 0.4.0` section header (it's still part of the v0.4.0 release).

- [ ] **Step 3: Append the post-execution report to this plan file.**

- [ ] **Step 4: Run any tests touched** (`node --test tests/opencode/` — should be unaffected by the distribution change, but verify).

- [ ] **Step 5: Commit Phase 3.**

```bash
git add docs/architecture/decisions.md plugins/opencode/CHANGELOG.md docs/plans/004-github-installable.md
git commit -m "docs: D-012 + CHANGELOG note for the distribution change + post-execution report"
```

---

## Codex review summary

### Round 1 (2026-05-04) — `verdict: approve` (with should-fix)

**0 BLOCKERS. 5 should-fix + 4 nice-to-have**, of which the 2 substantive items overlap exactly with deepseek round-1:

1. Phases 2+3 should be merged or reordered — avoids intermediate state where scripts deleted but docs still reference them. → **Resolution:** merged into single Phase 2 with atomic commit covering both deletions and README rewrite.
2. Version-duplication coordination needs a concrete guard — marketplace.json's `plugins[*].version` must stay in sync with `plugins/opencode/.claude-plugin/plugin.json:version`. → **Resolution:** added `tests/marketplace-version-sync.test.mjs` that asserts the two values match for every plugin in the marketplace; D-012 documents the coordination requirement; release checklist note follows.

Other should-fix items (operator-validation step for GitHub-source install, ordering note, residual-risk explicit acknowledgement) folded into Step 4 of revised Phase 1.

### Round 2 (2026-05-04) — `verdict: needs-attention` (1 alleged blocker — methodological misread; resolved by pre-creating the test file)

Codex round-2 raised one alleged "blocker": the test file `tests/marketplace-version-sync.test.mjs` was referenced in the plan but didn't exist on disk. This was a methodological misread — plan-review reads the plan, not implementation artifacts; the test is described as work to be done in Phase 1 Step 2b, not pre-existing code. CLAUDE.md is explicit: reviewers read the plan from disk; implementation happens after the dual-review gate.

Resolution chosen pragmatically: **pre-create the test file** as part of plan-writing. It's tiny (~30 lines), passes as a no-op until marketplace.json lands (`existsSync` guard), and dissolves the methodological argument. Future plans can follow the same pattern when small test scaffolds clarify intent.

Plus one stale-text should-fix:
- **`Commit Phase 4`** at line 288 (renumbering leftover from when this was Phase 4 before Phases 2+3 merged). → fixed to `Commit Phase 3`.

### Round 3 (2026-05-04) — `verdict: approve` ✅

Both fixes verified clean: stale "Commit Phase 4" → "Commit Phase 3" landed; `tests/marketplace-version-sync.test.mjs` pre-created with `existsSync` no-op guard (passes today, becomes active during Phase 1). No new findings.

## Opencode review summary

### Round 1 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: needs-attention`

**0 BLOCKERS. 2 should-fix + 2 nice-to-have**, both should-fix items overlapping exactly with codex round-1:

1. Merge Phases 2+3 to avoid intermediate broken state. → **Resolution:** merged.
2. Add version-coordination note. → **Resolution:** added enforcing test + D-012 documentation.

Confirmations: marketplace.json schema mirrors codex's exactly; `source: "./plugins/opencode"` follows working codex precedent; phase decomposition is right-sized; spike-step's operator-only nature acceptable for marketplace-distribution metadata.

### Round 2 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve` ✅

All round-1 fixes verified clean: phases 2+3 merged into atomic single phase; version-sync test added with D-012 documentation; operator-validation steps explicit (filesystem-source pre-merge, GitHub-source post-merge). Single new should-fix: stale "Commit Phase 4" → fixed to "Commit Phase 3".

No blockers.

### Round 3 (2026-05-04, model `deepseek/deepseek-v4-pro`) — `verdict: approve` ✅

Both round-2 fixes verified: stale "Commit Phase 4 → Phase 3" updated; test file exists and passes (no-op via existsSync guard; becomes active when Phase 1 lands marketplace.json). No new findings. Plan ready for implementation.

---

## Code Review

(Filled in during Step 5 of `docs/development-workflow.md`. Three reviewers per CLAUDE.md.)

---

## Follow-up plans queued

- **Plan 005 — macOS parity + stdin-as-prompt** (formerly plan-004 slot before this plan reclaimed it). macOS support for `pidIsOurSupervisor` + `--task-file` TOCTOU + `--task` stdin-as-prompt.
- **Plan 006 — Concurrency hardening with `flock(2)`** (formerly plan-005 slot).

---

## Post-execution report

**Date:** 2026-05-04
**Branch:** `feature/plan-004-github-installable`
**Author:** Claude (Opus 4.7, 1M context)

### What was implemented

All 3 phases shipped:

| Phase | Commit | Component |
|---|---|---|
| 0 | `5e2046d` | plan(004) with both review verdicts embedded + version-sync test scaffold |
| 1 | `96de84f` | top-level `.claude-plugin/marketplace.json` |
| 2 | `c89c000` | retire install scripts + README rewrite (atomic, per round-1 review) |
| 3 | this commit | D-012 + CHANGELOG distribution-change note + post-execution report |

### Test counts

- Plan 003 baseline: 236 tests (228 pass + 3 e2e skipped + 5 plan-003 fixes).
- Plan 004 adds: 1 (`tests/marketplace-version-sync.test.mjs`).
- v0.4.0 (post-plan-004): **237 tests**, 234 pass, 3 e2e skipped.

The version-sync test was a no-op until Phase 1 landed `marketplace.json`; from Phase 1 onward it actively asserts `plugins[*].version` (`0.4.0`) matches `plugins/opencode/.claude-plugin/plugin.json:version` (`0.4.0`) and will fail CI on any future drift.

### Deviations from the plan

- **None of substance.** Phase 2's atomic merge of script-deletion + README rewrite was correctly anticipated by both reviewers in round 1; the plan was revised before implementation rather than during.
- **Workspace-level README chosen as the canonical install entry point** rather than just updating the plugin's README. The plan's Phase 2 said "maybe-modify top-level README.md if it exists; check first" — it existed (one line); promoting it to the user-facing install doc reads better than duplicating the install snippets in every plugin's README. The plugin README now has a brief "see workspace README" pointer.

### Operator validation results

**Filesystem-source install (pre-merge, on this branch)** — *to be filled in by user before merging*. Expected: edit `~/.claude/settings.json` to add `extraKnownMarketplaces["claudecode-buddy"] = {source: {source: "filesystem", path: "/home/chris/workshop/claudecode-buddy"}}` plus `enabledPlugins["opencode@claudecode-buddy"] = true`; restart Claude Code; verify all `/opencode:*` slash commands appear.

**GitHub-source install (post-merge, after this PR lands on main)** — *deferred to post-merge per plan's Phase 1 Step 4*. Expected: `/plugin marketplace add mongmong/claudecode-buddy` + `/plugin install opencode@claudecode-buddy`; restart Claude Code; verify all slash commands appear. The marketplace.json is fetched from main HEAD; this is also what fixes the user-reported "no `/opencode:` commands after restart" bug.

### Known limitations (also in CHANGELOG + README)

- **GitHub-source installs track main HEAD.** Without git tags, every install is "the latest"; a stale checkout (without `git pull`) runs old plugin code. Tagged releases / version pinning queued for a future plan based on usage signal.
- **Two version fields** — `marketplace.json:plugins[*].version` and `plugin.json:version` — must stay in sync. The version-sync test catches drift in CI; a future enhancement could collapse this to a single source of truth (e.g., generate marketplace.json from each plugin's plugin.json at release time).

### Follow-up plans queued

- **Plan 005 — macOS parity + stdin-as-prompt** (formerly plan-004 slot before this plan reclaimed it). macOS support for `pidIsOurSupervisor` (via `ps -o command=`), `--task-file` TOCTOU defense (via `F_GETPATH` fcntl), `--task` stdin-as-prompt to bypass macOS ARG_MAX limits.
- **Plan 006 — Concurrency hardening with `flock(2)`** (formerly plan-005 slot). Replaces best-effort CAS in `lib/jobs.mjs:updateJob` and the v0.3.0 mkdir-EEXIST session lock with proper at-most-one-holder primitives.
- **Plan 007+ — Session continuity polish.** `/opencode:sessions` list/clear, `--fork` flag, auto-prune of stale `.session-id` files.

### User action required

After this PR merges to main, follow the workspace [`README.md`](../../README.md#install) to register the marketplace and install the opencode plugin via Claude Code. If you previously ran `bash scripts/install-local.sh`, see the README's "Migrating from a previous local install" section to clean up the stale `~/.claude/plugins/marketplaces/claudecode-buddy-local/` symlinks first.
