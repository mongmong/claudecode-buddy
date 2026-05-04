# Plan 000 — opencode plugin v1 scaffold (read-only review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/specs/opencode-plugin.md](../specs/opencode-plugin.md)

**Goal:** Scaffold the `opencode` Claude Code plugin with read-only review capability — `/opencode:review` slash command, `/opencode:setup` slash command, `opencode:opencode-review` subagent, internal `opencode-cli-runtime` skill, Node companion script, hybrid-output JSON-trailer schema, and a workspace-level `tests/` harness using `node:test`.

**Architecture:** Plugin lives at `plugins/opencode/`, mirroring the reference codex plugin layout. Slash commands and the subagent are thin Markdown wrappers that invoke a single Node companion script (`scripts/opencode-companion.mjs`) which is the sole point of contact with the `opencode` CLI. The companion script wraps `opencode run --format json --dangerously-skip-permissions`, parses the streamed JSON events to extract the assistant's final message, validates a fenced JSON trailer block against `schemas/review-trailer.schema.json`, and emits Markdown findings + a parsed verdict line to stdout.

**Tech Stack:** Node ≥18.18 (built-in `node:test`), Markdown plugin manifests, JSON Schema (handwritten validator — no `ajv` dependency in v1), opencode CLI v1.14+.

---

## Decisions resolved by this plan

The spec deferred three open questions to plan 000. Resolutions:

1. **Subagent name** — `opencode:opencode-review` (mirrors `codex:codex-rescue` redundant-prefix convention; forward-compatible with the planned `opencode:opencode-rescue` in plan 001).
2. **HANDOFF.md retire vs keep** — *retire after this plan ships*. Rationale: `docs/development-workflow.md` → "Session Handoff Rules" (Steps 1–4) already covers the recurring-handoff use case generically, and the bootstrap-specific content in HANDOFF.md is no longer accurate once plan 000 ships. Phase 8 includes a step to delete it.
3. **Schema validation library** — handwritten validator in `lib/trailer.mjs`, no `ajv` dependency. Rationale: the trailer schema is tiny (one enum field + a string array); a dependency would add ~500 KB of node_modules for a 20-line validator and would force the workspace into a lockfile management story we don't need yet.

### Design change adopted mid-plan (2026-05-03)

User requested: "opencode has many models supported, we should ask user to specify which model to use and pass as parameter each time calling."

**Resolution:** `/opencode:review` (the user-facing slash command) now prompts the user to pick a model each invocation, listing the models defined in `~/.config/opencode/opencode.json` via `AskUserQuestion`. The picked model is passed as `--model <provider/model>` to the companion script. Implemented by:

- New `lib/list-models.mjs` utility that walks the opencode config and returns a flat `provider/model-id` list (Task 2.6).
- New `models` companion subcommand that prints the list (Task 3.4).
- Updated `/opencode:review` body: Claude calls `companion models`, presents the list via `AskUserQuestion`, then calls `companion review --model <chosen> "$ARGUMENTS"` (Task 5.2).
- The `opencode:opencode-review` subagent is **NOT** changed — it stays silent (no user prompts) and uses whatever model the orchestrator passes via `--model`, falling back to the config default. Asking the user mid-orchestration would block programmatic flows like the dual plan-review gate.

Trade-off: per-invocation prompting adds friction for power users running many reviews back-to-back. We accept the friction in v1 because (a) the user explicitly asked for this UX, and (b) opencode's heterogeneous model support (each model has different cost, latency, and quality characteristics) makes "pick the right tool for this task" the meaningful default. A future plan can add a `--model-default <provider/model>` config option or a "remember my choice for this session" UX if the friction becomes painful.

---

## Phases

1. Plugin scaffold + CLAUDE.md rewrite
2. Companion script — pure utilities (TDD: prompt build, scope resolution, trailer extraction, schema validation, model listing)
3. Companion script — `setup` and `models` subcommands
4. Companion script — `review` and `prompt` subcommands (mocked opencode binary)
5. Slash commands (`/opencode:setup`, `/opencode:review` with per-invocation model picker)
6. Internal skill + subagent (free-form passthrough via heredoc + temp file)
7. End-to-end smoke tests against real opencode (gated)
8. Plugin README + CHANGELOG + post-execution report

Each phase ends with a green test run, a self-review pass, and a commit.

---

## Phase 1 — Plugin scaffold + CLAUDE.md rewrite

### Task 1.1: Create plugin directory tree

**Files:**
- Create: `plugins/opencode/.claude-plugin/plugin.json`
- Create: `plugins/opencode/commands/.gitkeep`
- Create: `plugins/opencode/agents/.gitkeep`
- Create: `plugins/opencode/skills/.gitkeep`
- Create: `plugins/opencode/scripts/.gitkeep`
- Create: `plugins/opencode/scripts/lib/.gitkeep`
- Create: `plugins/opencode/schemas/.gitkeep`
- Create: `tests/opencode/fixtures/.gitkeep`

**Layout deferrals (intentional, mirroring codex but staged):**

The reference codex plugin includes `hooks/` and `prompts/` directories that this plan deliberately omits:

- `hooks/` — codex uses hooks for SessionStart/SessionEnd/Stop, all wired to its background-task lifecycle and the optional Stop-time review gate. Plan 000 has no background tasks and no review gate, so no hooks are needed yet. Hooks land in plan 001 alongside background tasks.
- `prompts/` — codex stores larger prompt templates (e.g., `adversarial-review.md`, `stop-review-gate.md`) here. Plan 000's only prompt is the review framing, which is small enough to inline in `lib/prompt.mjs`. The `prompts/` directory lands in plan 002 alongside adversarial-review.

- [ ] **Step 1: Create the manifest**

`plugins/opencode/.claude-plugin/plugin.json`:

```json
{
  "name": "opencode",
  "version": "0.1.0",
  "description": "Use opencode from Claude Code to review code with whichever LLM you have configured.",
  "author": {
    "name": "claudecode-buddy"
  }
}
```

- [ ] **Step 2: Create empty subdirectories**

```bash
mkdir -p plugins/opencode/{commands,agents,skills,scripts/lib,schemas}
mkdir -p tests/opencode/fixtures
touch plugins/opencode/{commands,agents,skills,scripts,scripts/lib,schemas}/.gitkeep
touch tests/opencode/fixtures/.gitkeep
```

- [ ] **Step 3: Verify the layout**

Run: `find plugins/opencode tests/opencode -type f | sort`

Expected output (exactly):

```
plugins/opencode/.claude-plugin/plugin.json
plugins/opencode/agents/.gitkeep
plugins/opencode/commands/.gitkeep
plugins/opencode/schemas/.gitkeep
plugins/opencode/scripts/.gitkeep
plugins/opencode/scripts/lib/.gitkeep
plugins/opencode/skills/.gitkeep
tests/opencode/fixtures/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add plugins/opencode/ tests/opencode/
git commit -m "scaffold(opencode): plugin directory tree and manifest"
```

### Task 1.2: Rewrite CLAUDE.md to drop "review-only" framing

**Files:**
- Modify: `CLAUDE.md` — replace the "Opencode — Review Only" section, update plan-review-gate references, update code-review references, update Coding Agent / Don't sections.

- [ ] **Step 1: Read the current CLAUDE.md**

Run: `wc -l CLAUDE.md` to confirm it's the same file you brainstormed against.

- [ ] **Step 2: Replace the "Opencode — Review Only" section heading and body**

Find: `## Opencode — Review Only`

Replace with:

```markdown
## Opencode

opencode is being rolled out in this workspace as a third independent code-review and (eventually) coding agent, alongside Claude and Codex. The plugin lives at `plugins/opencode/` and is built up over phased plans:

- **Phase 1 (plan 000, this plan):** read-only review only — `/opencode:review`, `/opencode:setup`, `opencode:opencode-review` subagent. Foreground execution. Used by the dual plan-review gate and code-review process.
- **Phase 2 (plan 001):** write-capable rescue + background tasks — `/opencode:rescue`, `--background` execution, `/opencode:status` / `/opencode:result` / `/opencode:cancel`, `opencode:opencode-rescue` subagent.
- **Phase 3 (plan 002):** adversarial-review + optional Stop-hook review gate.

opencode runs whichever LLM the user has configured in `~/.config/opencode/opencode.json`. The plugin is model-agnostic — it never embeds a default model. Currently this user runs `volcengine-plan/glm-4.7`.

Until plan 000 ships, opencode is invoked via the CLI: `opencode run --dangerously-skip-permissions "<focused review prompt>"` from the repo root via the Bash tool. After plan 000 ships, prefer `/opencode:review` for interactive use and `Agent({subagent_type: "opencode:opencode-review"})` for programmatic dispatch (e.g., the dual plan-review gate).

Until plan 001 ships, opencode is review-only by capability — do not delegate coding tasks to it. After plan 001 ships, opencode-rescue can take write-capable tasks; Claude (Opus) remains the *primary* coding agent and opencode is a *secondary* agent for selective rescue.
```

- [ ] **Step 3: Update plan-review-gate references**

In the "CRITICAL RULES" section and the "Plan review gate (mandatory)" section, replace every occurrence of `opencode run --dangerously-skip-permissions "<focused review prompt>"` with the post-plan-000 form. Specifically:

Find (in CRITICAL RULES):
```
run an opencode review (CLI today: `opencode run --dangerously-skip-permissions "<focused review prompt>"` from the repo root via the Bash tool — switch to `/opencode:review` or the `opencode:opencode-rescue` subagent once this workspace ships them)
```

Replace with:
```
run an opencode review (after plan 000 ships: dispatch the `opencode:opencode-review` subagent via the `Agent` tool with a focused review prompt; before plan 000 ships: `opencode run --dangerously-skip-permissions "<focused review prompt>"` from the repo root via the Bash tool)
```

Find (in "Plan review gate" Step 2, second bullet):
```
   - `opencode run --dangerously-skip-permissions "<focused review prompt with the same questions>"` from the repo root via the Bash tool. (Once this workspace ships its own opencode plugin, switch to `/opencode:rescue` or the `opencode:opencode-rescue` subagent.)
```

Replace with:
```
   - Dispatch `opencode:opencode-review` via the `Agent` tool with the same questions as a focused review prompt. (Before plan 000 ships, fall back to `opencode run --dangerously-skip-permissions "<focused review prompt>"` from the repo root via the Bash tool.)
```

- [ ] **Step 4: Update Code Review section**

Find:
```
**Run BOTH `/codex:review` AND an opencode review pass** before creating a PR. Tag findings `[codex]` or `[opencode]` so the source is clear. All `[OPEN]` items from either reviewer must be resolved before opening the PR.
- Opencode invocation (until the plugin ships): `opencode run --dangerously-skip-permissions "Code review the changes on this branch (run \`git diff main...HEAD\`). Focus on correctness, security, consistency with the reference codex plugin layout, and the rules in CLAUDE.md. Flag issues with file:line references and an [OPEN] tag."` — run from the repo root via the Bash tool.
```

Replace with:
```
**Run BOTH `/codex:review` AND an opencode review pass** before creating a PR. Tag findings `[codex]` or `[opencode]` so the source is clear. All `[OPEN]` items from either reviewer must be resolved before opening the PR.
- Opencode invocation: dispatch `opencode:opencode-review` via the `Agent` tool with prompt: "Code review the changes on this branch (run `git diff main...HEAD`). Focus on correctness, security, consistency with the reference codex plugin layout, and the rules in CLAUDE.md. Flag issues with file:line references and an [OPEN] tag." Before plan 000 ships, fall back to: `opencode run --dangerously-skip-permissions "<same prompt>"` from the repo root via the Bash tool.
```

- [ ] **Step 5: Update `docs/code-review.md`**

Find:
```
This workspace runs **two independent reviewers** on every code review pass: Codex (`/codex:review`) and opencode (`opencode run --dangerously-skip-permissions "..."` until the local opencode plugin ships its own slash command). Each finding is tagged `[codex]` or `[opencode]` so its source is clear.
```

Replace with:
```
This workspace runs **two independent reviewers** on every code review pass: Codex (`/codex:review`) and opencode (the `opencode:opencode-review` subagent dispatched via the `Agent` tool — falls back to `opencode run --dangerously-skip-permissions "..."` before plan 000 ships). Each finding is tagged `[codex]` or `[opencode]` so its source is clear.
```

- [ ] **Step 6: Update `docs/development-workflow.md`**

Find (in Step 5):
```
Code review catches what self-review misses. Run BOTH `/codex:review` and an opencode review pass (CLI: `opencode run --dangerously-skip-permissions "..."` until this workspace ships its own slash command).
```

Replace with:
```
Code review catches what self-review misses. Run BOTH `/codex:review` and an opencode review pass (after plan 000 ships: dispatch `opencode:opencode-review` via the `Agent` tool; before plan 000 ships: `opencode run --dangerously-skip-permissions "..."`).
```

- [ ] **Step 7: Update the "Coding Agent" section**

Find:
```
**Claude Opus is the primary coding agent.** All implementation, debugging, refactoring, and coding tasks should be done by Claude (Opus model) — either directly or via subagents. Use the `superpowers:subagent-driven-development` skill for multi-task plan execution.

Do NOT delegate coding tasks to Codex or opencode. Both are review-only.
```

Replace with:
```
**Claude Opus is the primary coding agent.** All implementation, debugging, refactoring, and coding tasks should be done by Claude (Opus model) — either directly or via subagents. Use the `superpowers:subagent-driven-development` skill for multi-task plan execution.

Codex and opencode are *secondary* agents. Codex remains review-only in this workspace. opencode is review-only in plan 000 and becomes write-capable for selective rescue tasks in plan 001 — even after plan 001, Claude (Opus) remains the primary coding agent and opencode is a *secondary* agent for delegated rescue work, not the default.
```

- [ ] **Step 8: Update the "Codex (GPT-5.5) — Review Only" section's `Do NOT` line**

The Codex section's last line still applies (Codex stays review-only). No change there.

- [ ] **Step 9: Verify edits with grep**

Run:
```bash
grep -n "opencode run --dangerously-skip-permissions" CLAUDE.md docs/code-review.md docs/development-workflow.md
```

Expected: every remaining occurrence is inside an explicit "before plan 000 ships" fallback clause. There should be no naked occurrences asking the reader to use the raw CLI as the primary path.

Run:
```bash
grep -n "review-only" CLAUDE.md
```

Expected: every remaining "review-only" occurrence is either (a) about Codex (which stays review-only) or (b) explicitly scoped to plan 000 / phase 1.

Run:
```bash
grep -n "~/.opencode" CLAUDE.md docs/specs/opencode-plugin.md docs/plans/000-opencode-plugin-v1-scaffold.md
```

Expected: no occurrences (all references should be `~/.config/opencode/opencode.json`).

- [ ] **Step 10: Commit**

```bash
git add CLAUDE.md docs/code-review.md docs/development-workflow.md
git commit -m "docs: rewrite opencode references to point at the plan-000 surface"
```

### Task 1.3: Commit the spec

The spec was written during brainstorming but is not yet in a commit on this branch.

- [ ] **Step 1: Verify the spec exists**

Run: `ls docs/specs/opencode-plugin.md`

Expected: file exists.

- [ ] **Step 2: Commit**

```bash
git add docs/specs/opencode-plugin.md
git commit -m "spec: opencode plugin architecture and phased rollout"
```

---

## Phase 2 — Companion script utilities (TDD)

The companion script is broken into pure utility functions that are unit-tested without invoking opencode, plus subcommand handlers that orchestrate them. Phase 2 builds the pure utilities; Phases 3–4 build the subcommand handlers.

### Task 2.1: Set up workspace test harness

**Files:**
- Create: `tests/README.md`
- Create: `tests/opencode/helpers.mjs`
- Create: `package.json` (workspace root)

- [ ] **Step 1: Create workspace `package.json`**

`package.json` at the repo root:

```json
{
  "name": "claudecode-buddy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=18.18.0"
  },
  "scripts": {
    "test": "node --test tests/**/*.test.mjs"
  }
}
```

- [ ] **Step 2: Create `tests/README.md`**

```markdown
# Tests

Workspace-level test harness using Node's built-in `node:test` runner. No external dependencies.

## Layout

- `tests/<plugin>/*.test.mjs` — tests for each plugin under `plugins/<plugin>/`.
- `tests/<plugin>/helpers.mjs` — shared utilities for that plugin's tests.

## Running

```
npm test
```

## Tiers

1. **Unit** — pure functions; no subprocess. Always run.
2. **Integration with mocked opencode** — companion script invoked as a subprocess with `OPENCODE_BIN` overridden to a fixture script. Always run.
3. **End-to-end with real opencode** — companion script invoked against a real `opencode run` call. Gated behind `OPENCODE_E2E=1` env var. Run locally before each PR.
```

- [ ] **Step 3: Create `tests/opencode/helpers.mjs`**

```javascript
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function writeFixture(dir, relPath, contents) {
  const fullPath = join(dir, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, contents);
  return fullPath;
}

export function runCompanion(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["plugins/opencode/scripts/opencode-companion.mjs", ...args],
      { env: { ...process.env, ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
```

- [ ] **Step 4: Verify Node test runner works**

Run: `node --test --test-name-pattern='nothing-to-match' tests/ 2>&1 | head -5`

Expected: completes without error (no tests found is fine — we're checking the runner is invokable).

- [ ] **Step 5: Commit**

```bash
git add package.json tests/README.md tests/opencode/helpers.mjs
git commit -m "test(harness): workspace-level node:test runner and helpers"
```

### Task 2.2: Build prompt-construction utility (TDD)

**Files:**
- Create: `tests/opencode/prompt.test.mjs`
- Create: `plugins/opencode/scripts/lib/prompt.mjs`

- [ ] **Step 1: Write the failing test**

`tests/opencode/prompt.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt } from "../../plugins/opencode/scripts/lib/prompt.mjs";

test("buildReviewPrompt embeds the diff body verbatim", () => {
  const prompt = buildReviewPrompt({
    diff: "diff --git a/foo b/foo\n+bar",
    scope: "working-tree",
  });
  assert.match(prompt, /diff --git a\/foo b\/foo/);
  assert.match(prompt, /\+bar/);
});

test("buildReviewPrompt instructs the model to emit the JSON trailer", () => {
  const prompt = buildReviewPrompt({ diff: "x", scope: "branch", base: "main" });
  assert.match(prompt, /```json/);
  assert.match(prompt, /verdict/);
  assert.match(prompt, /blockers/);
});

test("buildReviewPrompt names the scope so the model knows what it is reviewing", () => {
  const wt = buildReviewPrompt({ diff: "x", scope: "working-tree" });
  const br = buildReviewPrompt({ diff: "x", scope: "branch", base: "main" });
  assert.match(wt, /working tree/i);
  assert.match(br, /branch.*main/i);
});

test("buildReviewPrompt rejects an empty diff with a clear error", () => {
  assert.throws(
    () => buildReviewPrompt({ diff: "", scope: "working-tree" }),
    /diff is empty/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/prompt.test.mjs`

Expected: FAIL — `Cannot find module 'plugins/opencode/scripts/lib/prompt.mjs'`.

- [ ] **Step 3: Implement `buildReviewPrompt`**

`plugins/opencode/scripts/lib/prompt.mjs`:

```javascript
const REVIEW_FRAMING = `You are a code reviewer. Review the following diff for correctness, security, consistency, and maintainability.

Output format (strict):

1. Markdown findings — numbered list. Each finding includes file:line references and a Critical / Should fix / Nice to have label.
2. A single fenced JSON trailer block (verbatim format below) at the very end of your reply.

The trailer must be valid JSON matching this shape:

\`\`\`json
{
  "verdict": "approve" | "needs-attention",
  "blockers": ["short blocker title", "another short blocker title"]
}
\`\`\`

Rules:
- "verdict" is "needs-attention" iff there is at least one Critical finding. Otherwise "approve".
- "blockers" lists only Critical findings (short titles, no detail). May be empty.
- Do NOT add any prose after the JSON block.
`;

export function buildReviewPrompt({ diff, scope, base }) {
  if (!diff || diff.trim().length === 0) {
    throw new Error("diff is empty — nothing to review");
  }
  const scopeLine =
    scope === "branch"
      ? `Scope: branch diff against base \`${base ?? "main"}\`.`
      : "Scope: working tree (uncommitted changes).";
  return `${REVIEW_FRAMING}\n${scopeLine}\n\n--- BEGIN DIFF ---\n${diff}\n--- END DIFF ---\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/opencode/prompt.test.mjs`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/opencode/prompt.test.mjs plugins/opencode/scripts/lib/prompt.mjs
git commit -m "feat(opencode): buildReviewPrompt utility with TDD coverage"
```

### Task 2.3: Build scope-resolution + diff retrieval utilities (TDD)

**Files:**
- Create: `tests/opencode/scope.test.mjs`
- Create: `plugins/opencode/scripts/lib/git.mjs`
- Create: `plugins/opencode/scripts/lib/scope.mjs`

This task uses `execFileSync` exclusively (no `shell: true`, no string interpolation) to prevent command injection through user-controlled inputs like `--base` or paths with spaces. Untracked file content is read from disk (not via `git show :0:<path>`, which only works for staged blobs), with size and binary-content guards.

- [ ] **Step 1: Write the failing test**

`tests/opencode/scope.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempRepo } from "./helpers.mjs";
import { resolveScope, getDiff } from "../../plugins/opencode/scripts/lib/scope.mjs";

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function initRepo(dir, mainBranch = "main") {
  git(dir, "init", "-q", "-b", mainBranch);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "init", "-q");
}

test("resolveScope.ok defaults to working-tree when scope is auto and there are uncommitted changes", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    writeFileSync(join(dir, "x.txt"), "hi\n");
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "working-tree");
  } finally {
    cleanup();
  }
});

test("resolveScope picks branch when scope is auto and working tree is clean but commits diverge from base", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    git(dir, "checkout", "-q", "-b", "feature");
    git(dir, "commit", "--allow-empty", "-m", "extra", "-q");
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "branch");
    assert.equal(resolved.value.base, "main");
  } finally {
    cleanup();
  }
});

test("resolveScope honors an explicit working-tree scope even when working tree is clean", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const resolved = resolveScope({ cwd: dir, scope: "working-tree", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "working-tree");
  } finally {
    cleanup();
  }
});

test("resolveScope reports an error when cwd is not a git repo", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /git/i);
  } finally {
    cleanup();
  }
});

test("resolveScope reports an error when base ref does not exist (branch scope)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const resolved = resolveScope({ cwd: dir, scope: "branch", base: "nonexistent-ref" });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /base/i);
  } finally {
    cleanup();
  }
});

test("resolveScope auto + clean-tree + missing-base surfaces an error (no silent fall-through)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    // Tree is clean; default base "main" exists; let's request a base that doesn't exist.
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "nonexistent-ref" });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /nonexistent-ref/);
    assert.match(resolved.error, /clean/i);
  } finally {
    cleanup();
  }
});

test("resolveScope auto + clean-tree + clean-vs-base returns working-tree (genuine no-op)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    // Tree is clean; base "main" exists; we are on main with no divergence.
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "working-tree");
  } finally {
    cleanup();
  }
});

test("getDiff includes staged, unstaged, AND untracked file CONTENT for working-tree scope", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "tracked content\n");
    git(dir, "add", "a.txt");
    writeFileSync(join(dir, "b.txt"), "untracked content\n");
    const result = getDiff({ cwd: dir, scope: "working-tree" });
    assert.equal(result.ok, true);
    assert.match(result.value, /a\.txt/);
    assert.match(result.value, /tracked content/);
    assert.match(result.value, /b\.txt/);
    assert.match(result.value, /untracked content/);
  } finally {
    cleanup();
  }
});

test("getDiff skips binary untracked files and oversized untracked files", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    // Binary file: contains a NUL byte
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    // Oversized file: > 1 MB
    writeFileSync(join(dir, "huge.txt"), "x".repeat(1024 * 1024 + 1));
    // A small text file alongside
    writeFileSync(join(dir, "small.txt"), "fine\n");
    const result = getDiff({ cwd: dir, scope: "working-tree" });
    assert.equal(result.ok, true);
    assert.match(result.value, /small\.txt/);
    assert.doesNotMatch(result.value, /binary content/);
    assert.match(result.value, /binary\.bin.*skipped/i);
    assert.match(result.value, /huge\.txt.*skipped/i);
  } finally {
    cleanup();
  }
});

test("getDiff returns branch diff when scope is branch", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "c.txt"), "new content\n");
    git(dir, "add", "c.txt");
    git(dir, "commit", "-q", "-m", "feature");
    const result = getDiff({ cwd: dir, scope: "branch", base: "main" });
    assert.equal(result.ok, true);
    assert.match(result.value, /c\.txt/);
    assert.match(result.value, /new content/);
  } finally {
    cleanup();
  }
});

test("getDiff handles paths with spaces and shell metacharacters safely", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const trickyPath = "weird $name; rm -rf x.txt";
    writeFileSync(join(dir, trickyPath), "safe\n");
    const result = getDiff({ cwd: dir, scope: "working-tree" });
    assert.equal(result.ok, true);
    assert.match(result.value, /weird/);
    assert.match(result.value, /safe/);
  } finally {
    cleanup();
  }
});

test("getDiff returns an error when git fails (e.g., bad base ref)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const result = getDiff({ cwd: dir, scope: "branch", base: "nonexistent-ref" });
    assert.equal(result.ok, false);
    assert.match(result.error, /git/i);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/scope.test.mjs`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the safe git helper**

`plugins/opencode/scripts/lib/git.mjs`:

```javascript
import { execFileSync } from "node:child_process";

const MAX_BUFFER = 32 * 1024 * 1024; // 32 MB

export function runGit(cwd, args) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    return {
      ok: false,
      code: err.status ?? null,
      stderr,
      error: `git ${args.join(" ")} failed (code ${err.status ?? "?"}): ${stderr.trim() || err.message}`,
    };
  }
}

export function gitRepoRoot(cwd) {
  const r = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return r;
  return { ok: true, value: r.stdout.trim() };
}
```

- [ ] **Step 4: Implement scope utilities**

`plugins/opencode/scripts/lib/scope.mjs`:

```javascript
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit, gitRepoRoot } from "./git.mjs";

const MAX_UNTRACKED_BYTES = 1024 * 1024; // 1 MB
const BINARY_SNIFF_BYTES = 8192;

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function looksBinary(buf) {
  const sniff = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  return sniff.includes(0x00);
}

function checkRepo(cwd) {
  const root = gitRepoRoot(cwd);
  if (!root.ok) return fail(`not a git repo: ${root.error}`);
  return ok(root.value);
}

function checkBase(cwd, base) {
  const r = runGit(cwd, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (!r.ok) return fail(`base ref \`${base}\` does not exist: ${r.error}`);
  return ok(true);
}

function hasWorkingTreeChanges(cwd) {
  const r = runGit(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!r.ok) return false;
  return r.stdout.trim().length > 0;
}

function hasBranchDivergence(cwd, base) {
  const r = runGit(cwd, ["diff", "--shortstat", `${base}...HEAD`]);
  if (!r.ok) return false;
  return r.stdout.trim().length > 0;
}

export function resolveScope({ cwd, scope, base }) {
  const resolvedBase = base ?? "main";
  const repoCheck = checkRepo(cwd);
  if (!repoCheck.ok) return repoCheck;

  if (scope === "branch") {
    const baseCheck = checkBase(cwd, resolvedBase);
    if (!baseCheck.ok) return baseCheck;
    return ok({ scope: "branch", base: resolvedBase });
  }
  if (scope === "working-tree") {
    return ok({ scope: "working-tree", base: resolvedBase });
  }
  // auto
  if (hasWorkingTreeChanges(cwd)) {
    return ok({ scope: "working-tree", base: resolvedBase });
  }
  // Tree is clean. Auto wants to try branch — but if base is missing, do not silently
  // fall back to "no diff = approve". Surface the base error so the user knows why
  // auto could not find anything to review.
  const baseCheck = checkBase(cwd, resolvedBase);
  if (!baseCheck.ok) {
    return fail(
      `scope=auto: working tree is clean and base ref \`${resolvedBase}\` does not exist. ` +
      `Specify --scope branch --base <existing-ref> with a valid ref, or make a working-tree change. ` +
      `(${baseCheck.error})`,
    );
  }
  if (hasBranchDivergence(cwd, resolvedBase)) {
    return ok({ scope: "branch", base: resolvedBase });
  }
  // Tree clean AND no divergence from a real base — there is genuinely nothing to review.
  return ok({ scope: "working-tree", base: resolvedBase });
}

function readUntrackedAsDiff(cwd, paths) {
  let out = "";
  for (const path of paths) {
    const fullPath = join(cwd, path);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_UNTRACKED_BYTES) {
      out += `\n# untracked: ${path} skipped (size ${stat.size} bytes exceeds 1 MB cap)\n`;
      continue;
    }
    let buf;
    try {
      buf = readFileSync(fullPath);
    } catch {
      continue;
    }
    if (looksBinary(buf)) {
      out += `\n# untracked: ${path} skipped (binary)\n`;
      continue;
    }
    const content = buf.toString("utf8");
    out += `\n--- /dev/null\n+++ b/${path}\n`;
    for (const line of content.split("\n")) {
      out += `+${line}\n`;
    }
  }
  return out;
}

export function getDiff({ cwd, scope, base }) {
  const repoCheck = checkRepo(cwd);
  if (!repoCheck.ok) return repoCheck;

  if (scope === "branch") {
    const resolvedBase = base ?? "main";
    const baseCheck = checkBase(cwd, resolvedBase);
    if (!baseCheck.ok) return baseCheck;
    const r = runGit(cwd, ["diff", `${resolvedBase}...HEAD`]);
    if (!r.ok) return fail(r.error);
    return ok(r.stdout);
  }
  // working-tree
  const staged = runGit(cwd, ["diff", "--cached"]);
  const unstaged = runGit(cwd, ["diff"]);
  const untrackedList = runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!staged.ok) return fail(staged.error);
  if (!unstaged.ok) return fail(unstaged.error);
  if (!untrackedList.ok) return fail(untrackedList.error);
  const untrackedDiff = readUntrackedAsDiff(
    cwd,
    untrackedList.stdout.split("\n").filter(Boolean),
  );
  const combined = [staged.stdout, unstaged.stdout, untrackedDiff]
    .filter((s) => s.trim())
    .join("\n");
  return ok(combined);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/opencode/scope.test.mjs`

Expected: 12 tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/opencode/scope.test.mjs plugins/opencode/scripts/lib/git.mjs plugins/opencode/scripts/lib/scope.mjs
git commit -m "feat(opencode): safe git helper, scope resolution, and diff retrieval"
```

### Task 2.4: Build trailer-extraction utility (TDD)

**Files:**
- Create: `tests/opencode/trailer.test.mjs`
- Create: `plugins/opencode/scripts/lib/trailer.mjs`

- [ ] **Step 1: Write the failing test**

`tests/opencode/trailer.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTrailer } from "../../plugins/opencode/scripts/lib/trailer.mjs";

test("extractTrailer parses a valid fenced JSON trailer", () => {
  const text = `## Findings\n\n1. Bug in foo.ts\n\n\`\`\`json\n{"verdict":"needs-attention","blockers":["Bug in foo.ts"]}\n\`\`\`\n`;
  const result = extractTrailer(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    verdict: "needs-attention",
    blockers: ["Bug in foo.ts"],
  });
});

test("extractTrailer parses approve verdict with empty blockers", () => {
  const text = "All good.\n\n```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```";
  const result = extractTrailer(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, "approve");
  assert.deepEqual(result.value.blockers, []);
});

test("extractTrailer fails when no JSON block is present", () => {
  const result = extractTrailer("Just prose, no JSON.");
  assert.equal(result.ok, false);
  assert.match(result.error, /no fenced JSON trailer/i);
});

test("extractTrailer fails when JSON is malformed", () => {
  const text = "```json\n{not valid}\n```";
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /parse/i);
});

test("extractTrailer fails when verdict is missing", () => {
  const text = '```json\n{"blockers":[]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /verdict/i);
});

test("extractTrailer fails when verdict is not in the enum", () => {
  const text = '```json\n{"verdict":"maybe","blockers":[]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /verdict/i);
});

test("extractTrailer fails when blockers is not an array of strings", () => {
  const text = '```json\n{"verdict":"approve","blockers":[1,2]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /blockers/i);
});

test("extractTrailer fails when blockers contains an empty string", () => {
  const text = '```json\n{"verdict":"approve","blockers":[""]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /non-empty/i);
});

test("extractTrailer fails when there is an unexpected additional property", () => {
  const text = '```json\n{"verdict":"approve","blockers":[],"extra":"nope"}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /additional|unexpected/i);
});

test("extractTrailer picks the LAST JSON block when there are multiple", () => {
  const text = '```json\n{"verdict":"approve","blockers":[]}\n```\n\nmore prose\n\n```json\n{"verdict":"needs-attention","blockers":["x"]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, "needs-attention");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/trailer.test.mjs`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement trailer extraction + validation**

`plugins/opencode/scripts/lib/trailer.mjs`:

```javascript
const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/g;

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

const ALLOWED_KEYS = new Set(["verdict", "blockers"]);

function validate(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return fail("trailer must be a JSON object");
  }
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      return fail(`trailer has unexpected additional property: ${JSON.stringify(key)}`);
    }
  }
  if (!("verdict" in obj)) return fail("trailer missing required field: verdict");
  if (obj.verdict !== "approve" && obj.verdict !== "needs-attention") {
    return fail(`trailer verdict must be "approve" or "needs-attention", got: ${JSON.stringify(obj.verdict)}`);
  }
  if (!("blockers" in obj)) return fail("trailer missing required field: blockers");
  if (!Array.isArray(obj.blockers)) return fail("trailer blockers must be an array");
  for (const b of obj.blockers) {
    if (typeof b !== "string") return fail("trailer blockers must contain only strings");
    if (b.length === 0) return fail("trailer blockers must contain non-empty strings");
  }
  return ok(obj);
}

export function extractTrailer(text) {
  const matches = [...text.matchAll(FENCE_RE)];
  if (matches.length === 0) {
    return fail("no fenced JSON trailer block found in opencode output");
  }
  const lastBlock = matches[matches.length - 1][1];
  let parsed;
  try {
    parsed = JSON.parse(lastBlock);
  } catch (err) {
    return fail(`failed to parse trailer JSON: ${err.message}`);
  }
  return validate(parsed);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/opencode/trailer.test.mjs`

Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/opencode/trailer.test.mjs plugins/opencode/scripts/lib/trailer.mjs
git commit -m "feat(opencode): JSON trailer extraction and schema validation"
```

### Task 2.5b: Build model-listing utility (TDD)

The `/opencode:review` UX (per design change adopted mid-plan) needs to enumerate the user's configured opencode models. This utility walks `~/.config/opencode/opencode.json` (or the path overridden by `OPENCODE_CONFIG`) and returns a flat list of `provider/model-id` strings.

**Files:**
- Create: `tests/opencode/list-models.test.mjs`
- Create: `plugins/opencode/scripts/lib/list-models.mjs`

- [ ] **Step 1: Write the failing test**

`tests/opencode/list-models.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempRepo } from "./helpers.mjs";
import { listModels } from "../../plugins/opencode/scripts/lib/list-models.mjs";

test("listModels returns a flat list of provider/model strings from a real-shaped config", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({
      model: "vendor-a/model-1",
      provider: {
        "vendor-a": {
          name: "Vendor A",
          models: { "model-1": { name: "Model 1" }, "model-2": { name: "Model 2" } },
        },
        "vendor-b": {
          name: "Vendor B",
          models: { "alpha": {}, "beta": {} },
        },
      },
    }));
    const result = listModels({ configPath: cfgPath });
    assert.equal(result.ok, true);
    // Default model is first (the user's preferred), remaining alphabetical by id.
    assert.equal(result.value[0], "vendor-a/model-1");
    assert.deepEqual(
      result.value.sort(),
      ["vendor-a/model-1", "vendor-a/model-2", "vendor-b/alpha", "vendor-b/beta"].sort(),
    );
  } finally {
    cleanup();
  }
});

test("listModels surfaces a clear error when the config is missing", () => {
  const result = listModels({ configPath: "/nonexistent/opencode.json" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("listModels surfaces a clear error when no provider has models", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({ model: "x/y", provider: {} }));
    const result = listModels({ configPath: cfgPath });
    assert.equal(result.ok, false);
    assert.match(result.error, /no models/i);
  } finally {
    cleanup();
  }
});

test("listModels handles a config with default model but no provider section", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    // Some opencode setups rely on the built-in provider catalog and only set
    // the default `model` field. listModels can only enumerate explicit
    // provider.<name>.models entries — degrade to "default model only".
    writeFileSync(cfgPath, JSON.stringify({ model: "anthropic/claude-sonnet-4-6" }));
    const result = listModels({ configPath: cfgPath });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, ["anthropic/claude-sonnet-4-6"]);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/list-models.test.mjs`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `listModels`**

`plugins/opencode/scripts/lib/list-models.mjs`:

```javascript
import { readFileSync, existsSync } from "node:fs";

export function listModels({ configPath }) {
  if (!existsSync(configPath)) {
    return { ok: false, error: `config not found at ${configPath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `failed to parse ${configPath}: ${err.message}` };
  }

  const found = new Set();

  // Always include the default `model` if set — it's the user's preferred pick.
  if (typeof parsed.model === "string" && parsed.model.length > 0) {
    found.add(parsed.model);
  }

  // Walk provider.<name>.models.<id>.
  if (parsed.provider && typeof parsed.provider === "object") {
    for (const [providerName, providerCfg] of Object.entries(parsed.provider)) {
      if (!providerCfg || typeof providerCfg !== "object") continue;
      const models = providerCfg.models;
      if (!models || typeof models !== "object") continue;
      for (const modelId of Object.keys(models)) {
        found.add(`${providerName}/${modelId}`);
      }
    }
  }

  if (found.size === 0) {
    return {
      ok: false,
      error:
        `no models found in ${configPath}. ` +
        `Set a default \`model\` field or add provider.<name>.models.<id> entries.`,
    };
  }

  // Default model first (if set), remaining alphabetical for stable output.
  const all = [...found];
  const def = typeof parsed.model === "string" ? parsed.model : null;
  const rest = all.filter((m) => m !== def).sort();
  return { ok: true, value: def ? [def, ...rest] : rest };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/opencode/list-models.test.mjs`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/opencode/list-models.test.mjs plugins/opencode/scripts/lib/list-models.mjs
git commit -m "feat(opencode): list-models utility for /opencode:review model picker"
```

### Task 2.5: Add the trailer schema file

**Files:**
- Create: `plugins/opencode/schemas/review-trailer.schema.json`

- [ ] **Step 1: Write the schema**

`plugins/opencode/schemas/review-trailer.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "opencode review trailer",
  "description": "Programmatic verdict + blocker list emitted as a fenced JSON block at the end of an opencode review.",
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "blockers"],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": ["approve", "needs-attention"]
    },
    "blockers": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    }
  }
}
```

The schema is documentation-only in v1 (the handwritten validator in `trailer.mjs` is the source of truth). It exists so external tools can consume it and so future plans can swap in `ajv` without changing the contract.

- [ ] **Step 2: Commit**

```bash
git add plugins/opencode/schemas/review-trailer.schema.json
git commit -m "schema(opencode): review trailer JSON schema"
```

---

## Phase 3 — `setup` subcommand

### Task 3.1: Build CLI-detection utility (TDD)

**Files:**
- Create: `tests/opencode/cli-detection.test.mjs`
- Create: `plugins/opencode/scripts/lib/cli-detection.mjs`

- [ ] **Step 1: Write the failing test**

`tests/opencode/cli-detection.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOpencode } from "../../plugins/opencode/scripts/lib/cli-detection.mjs";

test("detectOpencode reports a present binary by version", () => {
  // OPENCODE_BIN env override lets us point at a fixture.
  const result = detectOpencode({ env: { OPENCODE_BIN: "/usr/bin/true", PATH: process.env.PATH } });
  assert.equal(result.installed, true);
});

test("detectOpencode reports missing when binary is not on PATH", () => {
  const result = detectOpencode({
    env: { OPENCODE_BIN: "/nonexistent/opencode", PATH: "/nonexistent" },
  });
  assert.equal(result.installed, false);
  assert.match(result.guidance, /install/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/cli-detection.test.mjs`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement detection**

`plugins/opencode/scripts/lib/cli-detection.mjs`:

```javascript
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const INSTALL_GUIDANCE = `opencode is not installed or not on PATH.

Install: \`curl -fsSL https://opencode.ai/install | bash\`
Then verify: \`opencode --version\`

If opencode is installed at a non-standard path, set OPENCODE_BIN to the absolute binary path.`;

function resolveBinary(env) {
  if (env.OPENCODE_BIN) {
    if (existsSync(env.OPENCODE_BIN)) return env.OPENCODE_BIN;
    return null;
  }
  // Fall back to "opencode" on PATH.
  try {
    execFileSync("opencode", ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    return "opencode";
  } catch {
    return null;
  }
}

export function detectOpencode({ env = process.env } = {}) {
  const bin = resolveBinary(env);
  if (!bin) {
    return { installed: false, guidance: INSTALL_GUIDANCE };
  }
  let version = "unknown";
  try {
    version = execFileSync(bin, ["--version"], { env, encoding: "utf8" }).trim();
  } catch {
    // Binary exists but won't run — treat as installed-but-broken.
    return { installed: false, guidance: INSTALL_GUIDANCE, broken: true };
  }
  return { installed: true, binary: bin, version };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/opencode/cli-detection.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/opencode/cli-detection.test.mjs plugins/opencode/scripts/lib/cli-detection.mjs
git commit -m "feat(opencode): CLI presence detection with install guidance"
```

### Task 3.2: Build config-detection utility (TDD)

**Files:**
- Create: `tests/opencode/config-detection.test.mjs`
- Create: `plugins/opencode/scripts/lib/config-detection.mjs`

- [ ] **Step 1: Write the failing test**

`tests/opencode/config-detection.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectConfig } from "../../plugins/opencode/scripts/lib/config-detection.mjs";
import { makeTempRepo, writeFixture } from "./helpers.mjs";

test("detectConfig reports a valid config with a default model", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    writeFixture(dir, "opencode.json", JSON.stringify({ model: "vendor/model-a" }));
    const result = detectConfig({ configPath: `${dir}/opencode.json` });
    assert.equal(result.ok, true);
    assert.equal(result.model, "vendor/model-a");
  } finally {
    cleanup();
  }
});

test("detectConfig reports missing when file does not exist", () => {
  const result = detectConfig({ configPath: "/nonexistent/opencode.json" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("detectConfig reports malformed when JSON is invalid", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    writeFixture(dir, "opencode.json", "{not json");
    const result = detectConfig({ configPath: `${dir}/opencode.json` });
    assert.equal(result.ok, false);
    assert.match(result.error, /parse/i);
  } finally {
    cleanup();
  }
});

test("detectConfig reports missing-model when no default is set", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    writeFixture(dir, "opencode.json", JSON.stringify({ provider: {} }));
    const result = detectConfig({ configPath: `${dir}/opencode.json` });
    assert.equal(result.ok, false);
    assert.match(result.error, /model/i);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/config-detection.test.mjs`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement config detection**

`plugins/opencode/scripts/lib/config-detection.mjs`:

```javascript
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigPath() {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

export function detectConfig({ configPath = defaultConfigPath() } = {}) {
  if (!existsSync(configPath)) {
    return { ok: false, error: `config not found at ${configPath} — set a default model with \`opencode\` and configure your provider` };
  }
  let raw, parsed;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    return { ok: false, error: `failed to read config at ${configPath}: ${err.message}` };
  }
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `failed to parse config JSON at ${configPath}: ${err.message}` };
  }
  if (typeof parsed.model !== "string" || parsed.model.length === 0) {
    return { ok: false, error: `no default \`model\` field in ${configPath} — set one (e.g., "model": "anthropic/claude-sonnet-4-6")` };
  }
  return { ok: true, model: parsed.model, configPath };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/opencode/config-detection.test.mjs`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/opencode/config-detection.test.mjs plugins/opencode/scripts/lib/config-detection.mjs
git commit -m "feat(opencode): opencode.json config detection"
```

### Task 3.3: Wire `setup` subcommand into the companion script (TDD)

**Files:**
- Create: `tests/opencode/setup-cmd.test.mjs`
- Create: `plugins/opencode/scripts/opencode-companion.mjs`

- [ ] **Step 1: Write the failing test**

`tests/opencode/setup-cmd.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompanion, makeTempRepo, writeFixture } from "./helpers.mjs";

test("setup reports OK when binary and config are both present", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    writeFixture(dir, "opencode.json", JSON.stringify({ model: "vendor/model-a" }));
    const result = await runCompanion(["setup"], {
      OPENCODE_BIN: "/usr/bin/true",
      OPENCODE_CONFIG: `${dir}/opencode.json`,
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /opencode is installed/i);
    assert.match(result.stdout, /vendor\/model-a/);
  } finally {
    cleanup();
  }
});

test("setup reports missing binary with install guidance", async () => {
  const result = await runCompanion(["setup"], {
    OPENCODE_BIN: "/nonexistent/opencode",
    PATH: "/nonexistent",
    OPENCODE_CONFIG: "/nonexistent/opencode.json",
  });
  assert.equal(result.code, 0); // setup is informational, not a hard error
  assert.match(result.stdout, /not installed/i);
  assert.match(result.stdout, /install/i);
});

test("setup reports missing config when binary is present but config is not", async () => {
  const result = await runCompanion(["setup"], {
    OPENCODE_BIN: "/usr/bin/true",
    OPENCODE_CONFIG: "/nonexistent/opencode.json",
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /opencode is installed/i);
  assert.match(result.stdout, /config not found/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/setup-cmd.test.mjs`

Expected: FAIL — companion script does not exist yet.

- [ ] **Step 3: Implement the companion script entry point with `setup` subcommand**

`plugins/opencode/scripts/opencode-companion.mjs`:

```javascript
#!/usr/bin/env node
import { detectOpencode } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";

function runSetup() {
  const cli = detectOpencode({ env: process.env });
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const cfg = detectConfig({ configPath });

  const lines = [];
  if (cli.installed) {
    lines.push(`✓ opencode is installed (${cli.binary}, ${cli.version})`);
  } else {
    lines.push(`✗ opencode is not installed`);
    lines.push("");
    lines.push(cli.guidance);
  }

  lines.push("");

  if (cfg.ok) {
    lines.push(`✓ default model configured: ${cfg.model} (from ${cfg.configPath})`);
  } else {
    lines.push(`✗ ${cfg.error}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

const subcommand = process.argv[2];

switch (subcommand) {
  case "setup":
    runSetup();
    break;
  default:
    process.stderr.write(
      `Unknown subcommand: ${subcommand ?? "(none)"}.\nUsage: opencode-companion <setup|review> [args...]\n`,
    );
    process.exit(2);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/opencode/setup-cmd.test.mjs`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/opencode/setup-cmd.test.mjs plugins/opencode/scripts/opencode-companion.mjs
git commit -m "feat(opencode): companion script entry point with setup subcommand"
```

---

### Task 3.4: Wire `models` subcommand into the companion script (TDD)

The `/opencode:review` slash command's model picker needs a way to enumerate the user's models. Add a `models` subcommand that invokes `listModels` and prints one `provider/model-id` per line. The slash command body invokes this, then asks the user to pick.

**Files:**
- Create: `tests/opencode/models-cmd.test.mjs`
- Modify: `plugins/opencode/scripts/opencode-companion.mjs`

- [ ] **Step 1: Write the failing test**

`tests/opencode/models-cmd.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

test("models prints one provider/model per line, default first", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({
      model: "vendor-a/model-1",
      provider: {
        "vendor-a": { models: { "model-1": {}, "model-2": {} } },
        "vendor-b": { models: { "alpha": {} } },
      },
    }));
    const result = await runCompanion(["models"], { OPENCODE_CONFIG: cfgPath });
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n");
    // Default model first.
    assert.equal(lines[0], "vendor-a/model-1");
    // All models present.
    assert.deepEqual(lines.sort(), ["vendor-a/model-1", "vendor-a/model-2", "vendor-b/alpha"].sort());
  } finally {
    cleanup();
  }
});

test("models surfaces a clear error when config is missing", async () => {
  const result = await runCompanion(["models"], { OPENCODE_CONFIG: "/nonexistent/opencode.json" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not found/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/models-cmd.test.mjs`

Expected: FAIL — `models` subcommand returns "Unknown subcommand".

- [ ] **Step 3: Implement the `models` subcommand**

In `plugins/opencode/scripts/opencode-companion.mjs`, add the import:

```javascript
import { listModels } from "./lib/list-models.mjs";
```

Add the handler function (place near `runSetup`):

```javascript
function runModels() {
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const result = listModels({ configPath });
  if (!result.ok) {
    process.stdout.write(`${result.error}\n`);
    process.exit(0);
  }
  for (const m of result.value) {
    process.stdout.write(`${m}\n`);
  }
  process.exit(0);
}
```

Add the case to the subcommand switch:

```javascript
  case "models":
    runModels();
    break;
```

Update the usage string:

```javascript
process.stderr.write(
  `Unknown subcommand: ${subcommand ?? "(none)"}.\nUsage: opencode-companion <setup|models|review|prompt> [args...]\n`,
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/opencode/models-cmd.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/opencode/models-cmd.test.mjs plugins/opencode/scripts/opencode-companion.mjs
git commit -m "feat(opencode): models subcommand lists configured opencode models"
```

---

## Phase 4 — `review` subcommand (mocked opencode binary)

### Task 4.1: Build the opencode invocation wrapper (TDD)

**Files:**
- Create: `tests/opencode/invoke.test.mjs`
- Create: `plugins/opencode/scripts/lib/invoke.mjs`
- Create: `tests/opencode/fixtures/mock-opencode-success.mjs`
- Create: `tests/opencode/fixtures/mock-opencode-malformed.mjs`
- Create: `tests/opencode/fixtures/mock-opencode-multipart.mjs`
- Create: `tests/opencode/fixtures/mock-opencode-sleep.mjs`

The real opencode CLI (`opencode run --format json`) emits NDJSON events of shape `{type: "text", part: {type: "text", text: "...", messageID: "..."}}`. Multiple `text` events for the same `messageID` should be concatenated in arrival order to reconstruct the assistant message. The previous design's `{type: "message", role: "assistant", content: "..."}` shape is wrong — verified empirically by both reviewers in Round 1.

`invokeOpencode` also takes a `timeoutMs` argument (default 300000 / 5 min) and aborts the child process if exceeded.

- [ ] **Step 1: Create the success fixture (matches real opencode event shape)**

`tests/opencode/fixtures/mock-opencode-success.mjs`:

```javascript
#!/usr/bin/env node
// Pretends to be `opencode run --format json ...`. Emits canned NDJSON events
// in the SAME shape as the real opencode CLI (verified 2026-05-03).
const SESSION = "ses_mock_success";
const MSG = "msg_mock_success";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  {
    type: "text",
    sessionID: SESSION,
    part: {
      type: "text",
      messageID: MSG,
      sessionID: SESSION,
      text: "## Findings\n\n1. Looks fine.\n\n```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```\n",
    },
  },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
```

- [ ] **Step 2: Create the malformed fixture**

`tests/opencode/fixtures/mock-opencode-malformed.mjs`:

```javascript
#!/usr/bin/env node
const SESSION = "ses_mock_malformed";
const MSG = "msg_mock_malformed";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  {
    type: "text",
    sessionID: SESSION,
    part: {
      type: "text",
      messageID: MSG,
      sessionID: SESSION,
      text: "I refuse to add a JSON trailer.\n",
    },
  },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
```

- [ ] **Step 3: Create a multipart fixture (multiple text parts for same messageID)**

`tests/opencode/fixtures/mock-opencode-multipart.mjs`:

```javascript
#!/usr/bin/env node
const SESSION = "ses_mock_multi";
const MSG = "msg_mock_multi";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: MSG, sessionID: SESSION, text: "Part one.\n" } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: MSG, sessionID: SESSION, text: "Part two.\n" } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: MSG, sessionID: SESSION, text: "```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```" } },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
```

- [ ] **Step 4: Create a sleep fixture (for SIGTERM-respecting timeout testing)**

`tests/opencode/fixtures/mock-opencode-sleep.mjs`:

```javascript
#!/usr/bin/env node
// Hangs forever — used to verify invokeOpencode aborts on timeout.
// Default Node behavior is to honor SIGTERM, so this exits cleanly when killed.
setInterval(() => {}, 1000);
```

- [ ] **Step 5: Create a stubborn-sleep fixture (for SIGKILL escalation testing)**

`tests/opencode/fixtures/mock-opencode-stubborn-sleep.mjs`:

```javascript
#!/usr/bin/env node
// Ignores SIGTERM — used to verify invokeOpencode escalates to SIGKILL on timeout.
process.on("SIGTERM", () => {
  // Pretend we're a stubborn process that ignores SIGTERM.
});
setInterval(() => {}, 1000);
```

- [ ] **Step 6: Create a multi-message fixture (interleaved messageIDs)**

`tests/opencode/fixtures/mock-opencode-multi-message.mjs`:

```javascript
#!/usr/bin/env node
// Two messageIDs interleaved. msg_A first appears, then msg_B appears, then msg_A
// gets one more text part. The "final" message — by last-update-index — is msg_A.
const SESSION = "ses_mock_multi_msg";
const A = "msg_A";
const B = "msg_B";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: A } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: A, sessionID: SESSION, text: "A first.\n" } },
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: B } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: B, sessionID: SESSION, text: "B middle.\n" } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: A, sessionID: SESSION, text: "A FINISHES LAST." } },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: A } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
```

- [ ] **Step 7: Make all fixtures executable**

```bash
chmod +x tests/opencode/fixtures/mock-opencode-success.mjs \
         tests/opencode/fixtures/mock-opencode-malformed.mjs \
         tests/opencode/fixtures/mock-opencode-multipart.mjs \
         tests/opencode/fixtures/mock-opencode-sleep.mjs \
         tests/opencode/fixtures/mock-opencode-stubborn-sleep.mjs \
         tests/opencode/fixtures/mock-opencode-multi-message.mjs
```

- [ ] **Step 8: Write the failing test**

`tests/opencode/invoke.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeOpencode } from "../../plugins/opencode/scripts/lib/invoke.mjs";
import { resolve } from "node:path";

const SUCCESS_BIN = resolve("tests/opencode/fixtures/mock-opencode-success.mjs");
const MALFORMED_BIN = resolve("tests/opencode/fixtures/mock-opencode-malformed.mjs");
const MULTIPART_BIN = resolve("tests/opencode/fixtures/mock-opencode-multipart.mjs");
const SLEEP_BIN = resolve("tests/opencode/fixtures/mock-opencode-sleep.mjs");
const STUBBORN_SLEEP_BIN = resolve("tests/opencode/fixtures/mock-opencode-stubborn-sleep.mjs");
const MULTI_MSG_BIN = resolve("tests/opencode/fixtures/mock-opencode-multi-message.mjs");

test("invokeOpencode returns the assistant text reconstructed from text-typed events", async () => {
  const result = await invokeOpencode({
    binary: SUCCESS_BIN,
    prompt: "ignored by mock",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Looks fine/);
  assert.match(result.text, /verdict/);
});

test("invokeOpencode concatenates multiple text parts for the same messageID in order", async () => {
  const result = await invokeOpencode({
    binary: MULTIPART_BIN,
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Part one\./);
  assert.match(result.text, /Part two\./);
  assert.match(result.text, /verdict/);
  // Order matters: "Part one" must precede "Part two".
  assert.ok(result.text.indexOf("Part one") < result.text.indexOf("Part two"));
});

test("invokeOpencode passes through malformed (no-trailer) text — parsing happens later", async () => {
  const result = await invokeOpencode({
    binary: MALFORMED_BIN,
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /I refuse to add a JSON trailer/);
});

test("invokeOpencode reports a non-zero exit as failure", async () => {
  const result = await invokeOpencode({
    binary: "/usr/bin/false",
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /exit/i);
});

test("invokeOpencode reports missing binary as failure", async () => {
  const result = await invokeOpencode({
    binary: "/nonexistent/opencode",
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, false);
});

test("invokeOpencode aborts a SIGTERM-respecting process when timeoutMs is exceeded", async () => {
  const start = Date.now();
  const result = await invokeOpencode({
    binary: SLEEP_BIN,
    prompt: "x",
    cwd: process.cwd(),
    timeoutMs: 500,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
  // SIGTERM should suffice; well under the SIGKILL grace period.
  assert.ok(elapsed < 3000, `SIGTERM-respecting timeout took ${elapsed} ms, expected < 3000`);
});

test("invokeOpencode escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const start = Date.now();
  const result = await invokeOpencode({
    binary: STUBBORN_SLEEP_BIN,
    prompt: "x",
    cwd: process.cwd(),
    timeoutMs: 500,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
  // SIGTERM ignored; SIGKILL escalation grace is 2000 ms in the implementation.
  // Total: timeoutMs(500) + killGraceMs(2000) + scheduling slack(~500) = ~3000 ms ceiling.
  // A regression that doubles the kill grace to 4 s would elapse > 4500 ms and fail this assertion.
  assert.ok(elapsed < 3500, `SIGKILL escalation took ${elapsed} ms, expected < 3500`);
});

test("invokeOpencode picks the message whose last text event arrived latest (multi-messageID)", async () => {
  const result = await invokeOpencode({
    binary: MULTI_MSG_BIN,
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  // msg_A's last text event ("A FINISHES LAST.") arrived after msg_B's only text event.
  // Final winner = msg_A. Its concatenated text is "A first.\nA FINISHES LAST."
  assert.match(result.text, /A first\./);
  assert.match(result.text, /A FINISHES LAST\./);
  // msg_B's text must NOT be in the final returned message.
  assert.doesNotMatch(result.text, /B middle\./,
    `expected msg_A to win; got: ${result.text}`);
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `node --test tests/opencode/invoke.test.mjs`

Expected: FAIL — module not found.

- [ ] **Step 10: Implement `invokeOpencode`**

`plugins/opencode/scripts/lib/invoke.mjs`:

```javascript
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

function parseEvents(stdout) {
  // Real opencode events: { type: "text", part: { type: "text", messageID: "...", text: "..." } }
  // Group text by messageID. The "final" message is the one whose LAST text event
  // arrived latest in the stream — this is robust under interleaving where one
  // messageID emits early, another emits in the middle, and the first resumes at the end.
  const buffers = new Map(); // messageID -> { text: "", lastIdx: number }
  let idx = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-JSON log lines
    }
    if (ev.type !== "text") continue;
    if (!ev.part || ev.part.type !== "text") continue;
    if (typeof ev.part.text !== "string") continue;
    const id = ev.part.messageID ?? "_unknown_";
    if (!buffers.has(id)) buffers.set(id, { text: "", lastIdx: 0 });
    const entry = buffers.get(id);
    entry.text += ev.part.text;
    entry.lastIdx = idx++;
  }

  if (buffers.size === 0) return [];
  // Return in ascending lastIdx order so callers can pick the last as "final".
  return [...buffers.values()]
    .sort((a, b) => a.lastIdx - b.lastIdx)
    .map((entry) => entry.text);
}

export function invokeOpencode({
  binary,
  prompt,
  cwd,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolveResult) => {
    const args = ["run", "--dangerously-skip-permissions", "--format", "json", "--dir", cwd];
    if (model) args.push("--model", model);
    args.push(prompt);

    let child;
    try {
      child = spawn(binary, args, { cwd });
    } catch (err) {
      resolveResult({ ok: false, error: `failed to spawn ${binary}: ${err.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      // Escalate to SIGKILL after a short grace period.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveResult({ ok: false, error: `failed to invoke opencode: ${err.message}` });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveResult({
          ok: false,
          error: `opencode timed out after ${timeoutMs} ms (signal ${signal ?? "?"})\nstderr: ${stderr}`,
        });
        return;
      }
      if (code !== 0) {
        resolveResult({
          ok: false,
          error: `opencode exited with code ${code}\nstderr: ${stderr}`,
        });
        return;
      }
      const messages = parseEvents(stdout);
      if (messages.length === 0) {
        resolveResult({
          ok: false,
          error: `opencode produced no assistant text events\nstdout: ${stdout}`,
        });
        return;
      }
      // The final assistant message is the review.
      resolveResult({ ok: true, text: messages[messages.length - 1] });
    });
  });
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `node --test tests/opencode/invoke.test.mjs`

Expected: 8 tests pass.

- [ ] **Step 12: Commit**

```bash
git add tests/opencode/invoke.test.mjs tests/opencode/fixtures/ plugins/opencode/scripts/lib/invoke.mjs
git commit -m "feat(opencode): opencode CLI invocation with text-event parsing, timeout, and SIGKILL escalation"
```

### Task 4.2: Wire `review` subcommand (TDD)

**Files:**
- Create: `tests/opencode/review-cmd.test.mjs`
- Create: `plugins/opencode/scripts/lib/args.mjs`
- Modify: `plugins/opencode/scripts/opencode-companion.mjs`

This task introduces a `splitArgs` helper that handles both forms of `$ARGUMENTS`:
- multiple shell tokens (when the slash command says `... review $ARGUMENTS`), and
- one quoted string with embedded whitespace (when the slash command says `... review "$ARGUMENTS"`).

The codex plugin uses the quoted form. We adopt the same pattern so future free-form-text use cases (e.g., adversarial-review with a focus string in plan 002) work without re-plumbing.

- [ ] **Step 1: Write the splitArgs test**

`tests/opencode/args.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitArgs } from "../../plugins/opencode/scripts/lib/args.mjs";

test("splitArgs returns empty list for empty string", () => {
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs("   "), []);
});

test("splitArgs splits whitespace-separated tokens", () => {
  assert.deepEqual(splitArgs("--scope working-tree --base main"), [
    "--scope", "working-tree", "--base", "main",
  ]);
});

test("splitArgs preserves double-quoted tokens with internal whitespace", () => {
  assert.deepEqual(splitArgs('--prompt "hello world" --scope auto'), [
    "--prompt", "hello world", "--scope", "auto",
  ]);
});

test("splitArgs preserves single-quoted tokens with internal whitespace", () => {
  assert.deepEqual(splitArgs("--prompt 'hi there' --scope auto"), [
    "--prompt", "hi there", "--scope", "auto",
  ]);
});

test("splitArgs returns the input unchanged when already a list (called with array)", () => {
  // Some callers pass argv slices directly.
  const arr = ["--scope", "branch"];
  assert.deepEqual(splitArgs(arr), arr);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/opencode/args.test.mjs`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `splitArgs`**

`plugins/opencode/scripts/lib/args.mjs`:

```javascript
// Minimal shell-style argument splitter — handles single and double quotes.
// We deliberately do not implement variable expansion, escapes, or backticks.
// The caller is the slash command body, not user input.
export function splitArgs(input) {
  if (Array.isArray(input)) return input;
  const out = [];
  let i = 0;
  const s = input ?? "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n") { i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let token = "";
      while (i < s.length && s[i] !== quote) {
        token += s[i];
        i++;
      }
      i++; // skip closing quote
      out.push(token);
      continue;
    }
    let token = "";
    while (i < s.length && s[i] !== " " && s[i] !== "\t" && s[i] !== "\n") {
      token += s[i];
      i++;
    }
    out.push(token);
  }
  return out;
}
```

- [ ] **Step 4: Run the splitArgs test to verify it passes**

Run: `node --test tests/opencode/args.test.mjs`

Expected: 5 tests pass.

- [ ] **Step 5: Commit splitArgs**

```bash
git add tests/opencode/args.test.mjs plugins/opencode/scripts/lib/args.mjs
git commit -m "feat(opencode): splitArgs helper for slash-command argument parsing"
```

- [ ] **Step 6: Write the review-cmd test**

`tests/opencode/review-cmd.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

const SUCCESS_BIN = resolve("tests/opencode/fixtures/mock-opencode-success.mjs");
const MALFORMED_BIN = resolve("tests/opencode/fixtures/mock-opencode-malformed.mjs");

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function setupRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "init", "-q");
}

test("review with mocked opencode prints the assistant message and verdict line (multi-arg form)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Looks fine/);
    assert.match(result.stdout, /verdict.*approve/i);
  } finally {
    cleanup();
  }
});

test("review accepts the quoted single-arg form too", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope working-tree"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /verdict.*approve/i);
  } finally {
    cleanup();
  }
});

test("review reports an empty diff cleanly without invoking opencode", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /nothing to review/i);
  } finally {
    cleanup();
  }
});

test("review surfaces a git error (e.g., bad base ref) with needs-attention verdict", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--scope", "branch", "--base", "nonexistent-ref"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /git/i);
    assert.match(result.stdout, /verdict.*needs-attention/i);
  } finally {
    cleanup();
  }
});

test("review surfaces a parse error when opencode omits the JSON trailer", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "y.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_BIN: MALFORMED_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /I refuse to add a JSON trailer/);
    assert.match(result.stdout, /verdict.*needs-attention/i);
    assert.match(result.stdout, /parse error/i);
  } finally {
    cleanup();
  }
});

test("review surfaces a missing-binary error gracefully", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "z.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_BIN: "/nonexistent/opencode", PATH: "/nonexistent", OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /not installed/i);
  } finally {
    cleanup();
  }
});

test("review rejects unknown flags with exit 2 and a clear error", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--unknown-flag", "value"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown flag/i);
    assert.match(result.stderr, /--unknown-flag/);
  } finally {
    cleanup();
  }
});

test("review rejects unexpected positional arguments with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "stray-positional"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unexpected positional/i);
  } finally {
    cleanup();
  }
});

test("review accepts the mixed form: injected --model followed by a quoted multi-token $ARGUMENTS", async () => {
  // This is the shape produced by the slash command body:
  //   node companion.mjs review --model X "--scope working-tree"
  // Bash passes argv = ["review", "--model", "X", "--scope working-tree"], so
  // process.argv.slice(3) = ["--model", "X", "--scope working-tree"] (length 3).
  // parseReviewArgs must flatMap-splitArgs across each element, not only when
  // length === 1.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--model", "vendor/some-model", "--scope working-tree"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /verdict.*approve/i);
  } finally {
    cleanup();
  }
});

test("review honors last-occurrence wins for --model when injected and user-supplied both present", async () => {
  // Slash command may inject --model X in front of $ARGUMENTS that also contains
  // --model Y. Last-occurrence semantics make the user's explicit --model win.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--model", "injected/model", "--scope working-tree --model user/explicit"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    // We can't directly observe which --model invokeOpencode received from this
    // mock (the success fixture ignores its args), but we verify the parse did
    // not error out and the review completed.
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /verdict.*approve/i);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 7: Run the review-cmd test to verify it fails**

Run: `node --test tests/opencode/review-cmd.test.mjs`

Expected: FAIL — `review` subcommand returns "Unknown subcommand".

- [ ] **Step 8: Implement the `review` subcommand**

Modify `plugins/opencode/scripts/opencode-companion.mjs`:

Replace the entire file with:

```javascript
#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { detectOpencode } from "./lib/cli-detection.mjs";
import { detectConfig, defaultConfigPath } from "./lib/config-detection.mjs";
import { resolveScope, getDiff } from "./lib/scope.mjs";
import { buildReviewPrompt } from "./lib/prompt.mjs";
import { invokeOpencode } from "./lib/invoke.mjs";
import { extractTrailer } from "./lib/trailer.mjs";
import { splitArgs } from "./lib/args.mjs";
import { listModels } from "./lib/list-models.mjs";

function parseReviewArgs(rawArgs) {
  // Flatten: each rawArg may itself be a quoted multi-token string from the
  // slash-command's bash interpolation. splitArgs is idempotent on already-split
  // single tokens, so flatMap over every rawArg handles all three call shapes:
  //   ["--scope", "auto"]                    (multi-arg, already split)
  //   ["--scope auto"]                       (single quoted string)
  //   ["--model", "X", "--scope auto"]       (mixed: injected model + quoted $ARGUMENTS)
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  const out = { scope: "auto", base: "main", model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") out.scope = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --scope, --base, --model.` };
    } else if (a.length > 0) {
      return { ok: false, error: `unexpected positional argument: ${a}. The review subcommand only accepts flag-style arguments.` };
    }
  }
  return { ok: true, value: out };
}

function runSetup() {
  const cli = detectOpencode({ env: process.env });
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const cfg = detectConfig({ configPath });
  const lines = [];
  if (cli.installed) {
    lines.push(`✓ opencode is installed (${cli.binary}, ${cli.version})`);
  } else {
    lines.push(`✗ opencode is not installed`);
    lines.push("");
    lines.push(cli.guidance);
  }
  lines.push("");
  if (cfg.ok) {
    lines.push(`✓ default model configured: ${cfg.model} (from ${cfg.configPath})`);
  } else {
    lines.push(`✗ ${cfg.error}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

function runModels() {
  const configPath = process.env.OPENCODE_CONFIG ?? defaultConfigPath();
  const result = listModels({ configPath });
  if (!result.ok) {
    process.stdout.write(`${result.error}\n`);
    process.exit(0);
  }
  for (const m of result.value) {
    process.stdout.write(`${m}\n`);
  }
  process.exit(0);
}

function emitTextOnly(text) {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

function emitParsedVerdict(parsed) {
  process.stdout.write(`verdict: ${parsed.verdict}\n`);
  if (parsed.blockers.length > 0) {
    process.stdout.write(`blockers:\n`);
    for (const b of parsed.blockers) process.stdout.write(`  - ${b}\n`);
  } else {
    process.stdout.write(`blockers: (none)\n`);
  }
}

// For the `review` route: the prompt explicitly asked for a trailer, so missing
// trailer is a "needs-attention (parse error)" outcome.
function emitTextWithVerdict(text) {
  emitTextOnly(text);
  process.stdout.write("\n---\n");
  const trailer = extractTrailer(text);
  if (trailer.ok) {
    emitParsedVerdict(trailer.value);
  } else {
    process.stdout.write(`verdict: needs-attention (parse error)\n`);
    process.stdout.write(`parse error: ${trailer.error}\n`);
  }
}

// For the `prompt` route: the orchestrator may or may not have asked for a trailer.
// If a trailer is present, surface the verdict; otherwise emit text only without
// any synthesized verdict line (the caller did not request one).
function emitTextWithOptionalVerdict(text) {
  emitTextOnly(text);
  const trailer = extractTrailer(text);
  if (trailer.ok) {
    process.stdout.write("\n---\n");
    emitParsedVerdict(trailer.value);
  }
}

async function runReview(rawArgs) {
  const parsed = parseReviewArgs(rawArgs);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const args = parsed.value;
  const cwd = process.env.OPENCODE_REPO_ROOT ?? process.cwd();

  const cli = detectOpencode({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`opencode is not installed.\n\n${cli.guidance}\n`);
    process.exit(0);
  }

  const resolved = resolveScope({ cwd, scope: args.scope, base: args.base });
  if (!resolved.ok) {
    process.stdout.write(`scope resolution failed:\n${resolved.error}\n\nverdict: needs-attention (git error)\n`);
    process.exit(0);
  }

  const diff = getDiff({ cwd, scope: resolved.value.scope, base: resolved.value.base });
  if (!diff.ok) {
    process.stdout.write(`diff retrieval failed:\n${diff.error}\n\nverdict: needs-attention (git error)\n`);
    process.exit(0);
  }
  if (!diff.value.trim()) {
    process.stdout.write("nothing to review — diff is empty\n\nverdict: approve (no changes)\n");
    process.exit(0);
  }

  const prompt = buildReviewPrompt({
    diff: diff.value,
    scope: resolved.value.scope,
    base: resolved.value.base,
  });

  const invocation = await invokeOpencode({
    binary: cli.binary,
    prompt,
    cwd,
    model: args.model,
  });

  if (!invocation.ok) {
    process.stdout.write(`opencode invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }

  emitTextWithVerdict(invocation.text);
  process.exit(0);
}

function allowedPromptDir() {
  // The subagent writes prompt files under this directory; --prompt-file paths
  // must resolve under it. This contains the blast radius if the subagent's
  // heredoc delimiter is ever broken: even a successful breakout cannot read
  // arbitrary files because --prompt-file rejects out-of-bounds paths.
  const tmp = process.env.TMPDIR || "/tmp";
  try {
    const resolver = realpathSync.native ?? realpathSync;
    return resolver(tmp) + "/opencode-prompts";
  } catch {
    // $TMPDIR is a broken symlink or otherwise unresolvable. Fall back to /tmp.
    return "/tmp/opencode-prompts";
  }
}

function isUnderAllowedDir(filePath) {
  let resolved;
  try {
    resolved = realpathSync(filePath);
  } catch {
    return false; // file does not exist or symlink loop — reject
  }
  const base = allowedPromptDir();
  // Must be EXACTLY under base (with a path separator), not the directory itself.
  return resolved === base || resolved.startsWith(base + "/");
}

function parsePromptArgs(rawArgs) {
  // Returns { ok, text?, model?, error? }
  // Recognized flags: --prompt-file <path>, --model <provider/model>.
  // Anything else is treated as positional prompt text (joined by space) UNLESS
  // --prompt-file was used (in which case positional args are an error).
  const argv = rawArgs.flatMap((a) => splitArgs(a));
  let promptFile = null;
  let model = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt-file") {
      promptFile = argv[++i];
      if (!promptFile) return { ok: false, error: "--prompt-file requires a path argument" };
    } else if (a === "--model") {
      model = argv[++i];
      if (!model) return { ok: false, error: "--model requires a provider/model argument" };
    } else if (a === "--stdin") {
      return {
        ok: false,
        error:
          "--stdin is not supported in plan 000 (deferred for security review). " +
          "Use --prompt-file <path-under-$TMPDIR/opencode-prompts/> instead.",
      };
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}. Supported: --prompt-file, --model.` };
    } else if (a.length > 0) {
      positional.push(a);
    }
  }

  if (promptFile && positional.length > 0) {
    return {
      ok: false,
      error: "--prompt-file and positional prompt text are mutually exclusive",
    };
  }

  if (promptFile) {
    if (!isUnderAllowedDir(promptFile)) {
      return {
        ok: false,
        error:
          `--prompt-file path \`${promptFile}\` is not under the allowed prompt directory ` +
          `(${allowedPromptDir()}). The subagent must write prompt files via mktemp ` +
          `inside \$TMPDIR/opencode-prompts/.`,
      };
    }
    try {
      return { ok: true, text: readFileSync(promptFile, "utf8"), model };
    } catch (err) {
      return { ok: false, error: `failed to read prompt file ${promptFile}: ${err.message}` };
    }
  }

  return { ok: true, text: positional.join(" "), model };
}

async function runPrompt(rawArgs) {
  const input = parsePromptArgs(rawArgs);
  if (!input.ok) {
    process.stderr.write(`${input.error}\n`);
    process.exit(2);
  }
  // Trim only for the empty-check; pass the original verbatim text to opencode
  // so leading/trailing whitespace in the orchestrator's prompt is preserved.
  if (input.text.trim().length === 0) {
    process.stderr.write("prompt subcommand requires non-empty prompt text\n");
    process.exit(2);
  }
  const cwd = process.env.OPENCODE_REPO_ROOT ?? process.cwd();
  const cli = detectOpencode({ env: process.env });
  if (!cli.installed) {
    process.stdout.write(`opencode is not installed.\n\n${cli.guidance}\n`);
    process.exit(0);
  }

  // Model precedence: --model flag > OPENCODE_MODEL env > opencode config default.
  const model = input.model ?? process.env.OPENCODE_MODEL ?? null;

  const invocation = await invokeOpencode({
    binary: cli.binary,
    prompt: input.text,
    cwd,
    model,
  });

  if (!invocation.ok) {
    process.stdout.write(`opencode invocation failed:\n${invocation.error}\n\nverdict: needs-attention (invocation error)\n`);
    process.exit(0);
  }
  emitTextWithOptionalVerdict(invocation.text);
  process.exit(0);
}

const subcommand = process.argv[2];
const rest = process.argv.slice(3);

switch (subcommand) {
  case "setup":
    runSetup();
    break;
  case "models":
    runModels();
    break;
  case "review":
    runReview(rest);
    break;
  case "prompt":
    runPrompt(rest);
    break;
  default:
    process.stderr.write(
      `Unknown subcommand: ${subcommand ?? "(none)"}.\nUsage: opencode-companion <setup|models|review|prompt> [args...]\n`,
    );
    process.exit(2);
}
```

- [ ] **Step 9: Run all tests so far**

Run: `npm test`

Expected: every test from Phases 2, 3, and 4 passes (review-cmd tests pass; prompt-cmd tests come in Task 4.3).

- [ ] **Step 10: Commit**

```bash
git add tests/opencode/review-cmd.test.mjs plugins/opencode/scripts/opencode-companion.mjs
git commit -m "feat(opencode): review and prompt subcommand routing with safe arg parsing"
```

### Task 4.3: Test the `prompt` subcommand (TDD)

The `prompt` subcommand was implemented in Task 4.2 (it shares so much code with `review` that splitting the implementation across two commits would be wasteful), but its tests live here so the TDD discipline applies to the new behavior surface.

**Files:**
- Create: `tests/opencode/prompt-cmd.test.mjs`

- [ ] **Step 1: Write the test**

`tests/opencode/prompt-cmd.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

const SUCCESS_BIN = resolve("tests/opencode/fixtures/mock-opencode-success.mjs");
const MALFORMED_BIN = resolve("tests/opencode/fixtures/mock-opencode-malformed.mjs");

test("prompt forwards a positional free-form text and emits a verdict line when trailer is present", async () => {
  const result = await runCompanion(
    ["prompt", "Review the plan at docs/plans/000-foo.md against the spec at docs/specs/foo.md. Focus on blockers."],
    { OPENCODE_BIN: SUCCESS_BIN },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Looks fine/);
  assert.match(result.stdout, /verdict.*approve/i);
});

test("prompt --prompt-file reads the prompt from disk under the allowed dir (subagent route)", async () => {
  // Set TMPDIR to a controlled location and place the prompt file under
  // $TMPDIR/opencode-prompts/ to satisfy the realpath check.
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const promptDir = join(tmpdir, "opencode-prompts");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = join(promptDir, "prompt.txt");
    writeFileSync(
      promptPath,
      'Tricky body with $VAR backticks `whoami` $(echo evil) and "double quotes".\n',
    );
    const result = await runCompanion(
      ["prompt", "--prompt-file", promptPath],
      { OPENCODE_BIN: SUCCESS_BIN, TMPDIR: tmpdir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Looks fine/);
    assert.match(result.stdout, /verdict.*approve/i);
  } finally {
    cleanup();
  }
});

test("prompt --prompt-file rejects paths OUTSIDE the allowed dir (path-traversal defense)", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    // File exists but is outside $TMPDIR/opencode-prompts/.
    const sneakyPath = join(tmpdir, "sneaky.txt");
    writeFileSync(sneakyPath, "would leak");
    const result = await runCompanion(
      ["prompt", "--prompt-file", sneakyPath],
      { OPENCODE_BIN: SUCCESS_BIN, TMPDIR: tmpdir },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not under the allowed/i);
  } finally {
    cleanup();
  }
});

test("prompt --prompt-file rejects /etc/passwd-style traversal even with ../", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const promptDir = join(tmpdir, "opencode-prompts");
    mkdirSync(promptDir, { recursive: true });
    // Try to traverse out using a relative path inside the allowed dir.
    const sneakyPath = join(promptDir, "..", "outside.txt");
    writeFileSync(join(tmpdir, "outside.txt"), "would leak");
    const result = await runCompanion(
      ["prompt", "--prompt-file", sneakyPath],
      { OPENCODE_BIN: SUCCESS_BIN, TMPDIR: tmpdir },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not under the allowed/i);
  } finally {
    cleanup();
  }
});

test("prompt --prompt-file surfaces a clear error when the file does not exist", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const promptDir = join(tmpdir, "opencode-prompts");
    mkdirSync(promptDir, { recursive: true });
    const result = await runCompanion(
      ["prompt", "--prompt-file", join(promptDir, "missing.txt")],
      { OPENCODE_BIN: SUCCESS_BIN, TMPDIR: tmpdir },
    );
    assert.notEqual(result.code, 0);
    // realpath fails first → "not under the allowed" since nonexistent paths can't be canonicalized.
    assert.match(result.stderr, /not under the allowed|failed to read/i);
  } finally {
    cleanup();
  }
});

test("prompt --stdin is rejected in plan 000", async () => {
  const result = await runCompanion(["prompt", "--stdin"], { OPENCODE_BIN: SUCCESS_BIN });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--stdin is not supported/i);
});

test("prompt preserves leading and trailing whitespace verbatim (no .trim before forwarding)", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const promptDir = join(tmpdir, "opencode-prompts");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = join(promptDir, "prompt.txt");
    // Leading and trailing whitespace must reach opencode unchanged.
    writeFileSync(promptPath, "   leading space\nbody\ntrailing newlines\n\n\n");
    const result = await runCompanion(
      ["prompt", "--prompt-file", promptPath],
      { OPENCODE_BIN: SUCCESS_BIN, TMPDIR: tmpdir },
    );
    assert.equal(result.code, 0);
    // We can't easily inspect the prompt sent to opencode (the mock ignores it),
    // but we CAN assert the call succeeded — the implementation should not have
    // mutated the prompt before passing it. A regression that re-introduces
    // .trim() would still pass this test, so the contract is also enforced by
    // code review on the implementation. Leaving this as a smoke test that the
    // pipeline tolerates leading/trailing whitespace.
    assert.match(result.stdout, /Looks fine/);
  } finally {
    cleanup();
  }
});

test("prompt does NOT synthesize a verdict line when the model omits the trailer", async () => {
  const result = await runCompanion(
    ["prompt", "Some free-form question with no trailer requested"],
    { OPENCODE_BIN: MALFORMED_BIN },
  );
  assert.equal(result.code, 0);
  // Raw text passes through.
  assert.match(result.stdout, /I refuse/);
  // No verdict line, no parse error — orchestrator did not request a trailer.
  assert.doesNotMatch(result.stdout, /^verdict:/m);
  assert.doesNotMatch(result.stdout, /parse error/i);
});

test("prompt rejects an empty prompt with non-zero exit", async () => {
  const result = await runCompanion(["prompt", "   "], { OPENCODE_BIN: SUCCESS_BIN });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /non-empty/i);
});

test("prompt surfaces a missing-binary error gracefully", async () => {
  const result = await runCompanion(
    ["prompt", "Review the changes"],
    { OPENCODE_BIN: "/nonexistent/opencode", PATH: "/nonexistent" },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not installed/i);
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test tests/opencode/prompt-cmd.test.mjs`

Expected: 10 tests pass (the implementation already exists from Task 4.2).

- [ ] **Step 3: Commit**

```bash
git add tests/opencode/prompt-cmd.test.mjs
git commit -m "test(opencode): prompt subcommand coverage"
```

---

## Phase 5 — Slash commands

### Task 5.1: `/opencode:setup` slash command

**Files:**
- Create: `plugins/opencode/commands/setup.md`
- Delete: `plugins/opencode/commands/.gitkeep`

- [ ] **Step 1: Write the slash command file**

`plugins/opencode/commands/setup.md`:

```markdown
---
description: Check whether the local opencode CLI is ready and a default model is configured
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup
```

Present the full command output to the user verbatim. Do not summarize.

If the output indicates opencode is not installed, do not auto-install — surface the install guidance from the script as-is. opencode is distributed as a binary via `curl -fsSL https://opencode.ai/install | bash`, not via npm; auto-installing would require downloading and executing a remote binary, which warrants explicit user consent rather than a one-line prompt.

If the output indicates the config is missing or has no default model, surface that to the user with the script's guidance line.
```

- [ ] **Step 2: Remove placeholder**

```bash
rm plugins/opencode/commands/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add plugins/opencode/commands/setup.md
git rm plugins/opencode/commands/.gitkeep
git commit -m "feat(opencode): /opencode:setup slash command"
```

### Task 5.2: `/opencode:review` slash command (with model picker)

**Files:**
- Create: `plugins/opencode/commands/review.md`

- [ ] **Step 1: Write the slash command file**

`plugins/opencode/commands/review.md`:

```markdown
---
description: Run an opencode code review against local git state (foreground only in v1)
argument-hint: '[--scope auto|working-tree|branch] [--base <ref>] [--model <provider/model>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an opencode review through the companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the script's output verbatim to the user.

Pre-flight (size estimation):
- Inspect `git status --short --untracked-files=all`.
- Inspect `git diff --shortstat --cached` and `git diff --shortstat`.
- For branch scope, also inspect `git diff --shortstat <base>...HEAD`.
- If the change set is non-trivial (more than ~10 files or unclear size), warn the user that an opencode run is billable on whichever provider they have configured. Use `AskUserQuestion` exactly once with two options:
  - `Run the review (Recommended)` (or just `Run the review` if size is unclear)
  - `Cancel`
- If the change set is empty, tell the user "nothing to review" and stop without invoking opencode.

Model selection (REQUIRED before invoking review):

The user's opencode config typically defines multiple models with different cost / latency / quality characteristics. Always ask the user which model to use for THIS review, even if they have a default configured. Skip the prompt only when the user already supplied `--model <provider/model>` in `$ARGUMENTS`.

1. **Detect user-supplied --model in $ARGUMENTS.** If `$ARGUMENTS` contains a `--model <value>` token (look for the literal flag), skip the picker and jump to the Execution step.
2. **Otherwise, list available models:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" models
```

3. The script prints one `provider/model-id` per line, default first. If the output starts with "config not found" or otherwise looks like an error (no `/` separator on any line), surface it to the user verbatim and stop without invoking review.
4. **AskUserQuestion** with one option per listed model (default model first, suffixed with `(default)`). The AskUserQuestion UI in Claude Code supports up to 4 options per question. If the model list has 4 or fewer entries, present them all; if more than 4, present the first 3 plus a fourth option `Other (specify model id)`. If the user picks `Other`, prompt them with a follow-up free-text question for the exact `provider/model-id`. **Validate the typed value against the model list captured in step 2** (no need to re-run `companion models` — the listing is in your context); if the typed value doesn't match any listed model, repeat the picker once and then bail out. Question text: `"Which opencode model should run this review?"`.
5. **Capture the user's choice as `$CHOSEN_MODEL`.** If for any reason `$CHOSEN_MODEL` is empty after the picker (user cancelled, validation failed twice, etc.), stop without invoking review and tell the user "model selection cancelled".

Execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review --model "$CHOSEN_MODEL" "$ARGUMENTS"
```

If the user-supplied `--model` path was taken (step 1), invoke instead WITHOUT the injected `--model`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review "$ARGUMENTS"
```

The companion's `parseReviewArgs` flat-maps `splitArgs` across every input token, so `["--model", "X", "--scope working-tree"]` (mixed multi-arg + quoted) parses correctly. Last-occurrence wins on duplicate flags.

Output handling:
- Return the script's stdout verbatim.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Argument handling:
- Preserve the user's arguments exactly (apart from injecting the model picker's choice).
- The script accepts `--scope`, `--base`, and `--model`. Unknown flags or unexpected positional arguments are rejected with exit 2 and a clear error message — surface that error to the user verbatim.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/opencode/commands/review.md
git commit -m "feat(opencode): /opencode:review slash command with per-invocation model picker"
```

---

## Phase 6 — Internal skill + subagent

### Task 6.1: `opencode-cli-runtime` internal skill

**Files:**
- Create: `plugins/opencode/skills/opencode-cli-runtime/SKILL.md`
- Delete: `plugins/opencode/skills/.gitkeep`

- [ ] **Step 1: Write the skill file**

`plugins/opencode/skills/opencode-cli-runtime/SKILL.md`:

```markdown
---
name: opencode-cli-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# Opencode Runtime

Use this skill only inside the `opencode:opencode-review` subagent (and, in future plans, `opencode:opencode-rescue`).

Primary helper for free-form prompt forwarding (the subagent's main mode):
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" prompt --prompt-file <path>` — REQUIRED form for the subagent. The prompt body must be written to a temp file via a quoted-delimiter heredoc; never inline the prompt text into the bash command line. See `agents/opencode-review.md` for the exact pattern.

Secondary helper for git-diff convenience review (rarely used by the subagent — `/opencode:review` covers that):
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review "<flag-style args>"`

Other input modes for `prompt`:
- `... prompt <positional words>` — joined by space; only safe when the prompt is known to contain no shell metacharacters. The subagent never uses this; reserved for ad-hoc CLI testing.
- `--stdin` is explicitly **NOT supported in plan 000** (security review deferred — it would enable arbitrary file reads via shell redirection).

Execution rules:
- The review subagent is a forwarder, not an orchestrator. Its only job is to invoke ONE companion subcommand once and return that stdout unchanged.
- Prefer `prompt` for forwarded review requests from the orchestrator. The orchestrator constructs the full review prompt (including any references to specific files, focus questions, or expected output format).
- Use `review` only when the orchestrator explicitly says "review the working-tree diff" or "review the branch diff" without supplying its own prompt text.
- Do not call `setup` from the review subagent — `/opencode:setup` is a user-facing command.

Output:
- Return the stdout of the companion command verbatim.
- The orchestrator parses the trailing `verdict:` line for routing decisions; do not reformat or strip it.
- Do not paraphrase, summarize, or add commentary before or after it.
- If the Bash call fails or opencode cannot be invoked, return the script's stderr verbatim.

Trailer behavior — important contract difference between the two routes:
- `review` route: the prompt explicitly asks the model for a trailer. Missing trailer → `verdict: needs-attention (parse error)` is always printed.
- `prompt` route: the orchestrator may or may not have asked for a trailer. If a trailer is present, the script prints both the text and a parsed verdict line. If no trailer is present, the script prints the text only — no verdict line is synthesized. Orchestrators that need a verdict signal must include hybrid-output instructions in the prompt body (typically a fenced JSON block with `verdict` and `blockers`).
```

- [ ] **Step 2: Remove placeholder**

```bash
rm plugins/opencode/skills/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add plugins/opencode/skills/opencode-cli-runtime/SKILL.md
git rm plugins/opencode/skills/.gitkeep
git commit -m "feat(opencode): opencode-cli-runtime internal skill"
```

### Task 6.2: `opencode-review` subagent

**Files:**
- Create: `plugins/opencode/agents/opencode-review.md`
- Delete: `plugins/opencode/agents/.gitkeep`

- [ ] **Step 1: Write the subagent file**

`plugins/opencode/agents/opencode-review.md`:

```markdown
---
name: opencode-review
description: Programmatic opencode review delegation. Dispatch this subagent when Claude needs a third independent review verdict on a plan, spec, code change, or anything else (e.g., the dual plan-review gate).
model: sonnet
tools: Bash
skills:
  - opencode-cli-runtime
---

You are a thin forwarding wrapper around the opencode companion runtime.

Your only job is to forward the orchestrator's review prompt to the opencode companion script. Do not do anything else.

Selection guidance:

- Use this subagent when the orchestrator wants a third independent review pass (alongside Claude and Codex), typically for the dual plan-review gate, spec review, or post-implementation code review.
- Do not use it to fix issues, write code, or do follow-up work — opencode runs review-only in this plan.

Two routing modes:

1. **Free-form prompt forwarding (PRIMARY)** — for plan reviews, spec reviews, focused-question reviews. The orchestrator's request is a complete prompt with file references, questions, and output format expectations.

   Use a heredoc with a *quoted* delimiter (`<<'<DELIMITER>'`) to write the prompt to a temp file under `$TMPDIR/opencode-prompts/run-XXXXXX/`, then pass the file path to the companion. The quoted delimiter prevents Bash from evaluating any `$VAR`, `` ` `` (backticks), `$()`, or quote characters inside the prompt body.

   **REQUIRED safety check before constructing the heredoc:** Inspect the orchestrator's prompt body. If it contains the literal string `OPENCODE_PROMPT_DELIMITER_DO_NOT_USE_IN_PROMPT_xK7p2qR9_END` on any line by itself, abort with the stderr message `"prompt body contains the reserved heredoc delimiter; refusing to forward"` and return exit 2. The delimiter is specifically constructed to be improbable, but the safety check is mandatory.

   **The companion's `--prompt-file` mode rejects paths outside `$TMPDIR/opencode-prompts/`** (defense in depth). Always use `mktemp -d` to create the per-invocation directory exactly as shown.

```bash
PROMPT_BASE="${TMPDIR:-/tmp}/opencode-prompts"
mkdir -p "$PROMPT_BASE"
PROMPT_DIR=$(mktemp -d "$PROMPT_BASE/run-XXXXXX")
PROMPT_FILE="$PROMPT_DIR/prompt.txt"
cat > "$PROMPT_FILE" <<'OPENCODE_PROMPT_DELIMITER_DO_NOT_USE_IN_PROMPT_xK7p2qR9_END'
<orchestrator's full prompt text — any content, including $variables, backticks, quotes>
OPENCODE_PROMPT_DELIMITER_DO_NOT_USE_IN_PROMPT_xK7p2qR9_END
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" prompt --prompt-file "$PROMPT_FILE"
RC=$?
rm -rf "$PROMPT_DIR"
exit $RC
```

**Optional: orchestrator-supplied model.** If the orchestrator wants opencode to run on a specific model (e.g., the dual plan-review gate may want a specific reviewer model), include `--model <provider/model>` in the companion invocation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" prompt --prompt-file "$PROMPT_FILE" --model "anthropic/claude-sonnet-4-6"
```

If `--model` is omitted, the prompt subcommand falls back to the `OPENCODE_MODEL` env var (if set), then to opencode's configured default.

2. **Git-diff convenience (SECONDARY)** — only when the orchestrator explicitly says "review the working-tree diff" or "review branch X" without supplying its own prompt text. Arguments here are *flag-style only* (`--scope`, `--base`, `--model`); the companion's argument parser whitelists known flags so injection through this route is bounded.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review "$FLAGS"
```

Forwarding rules:

- Use exactly one logical Bash invocation per call (the heredoc + companion + cleanup is one such invocation).
- Choose `prompt` mode when the orchestrator includes any free-form instruction text. Choose `review` mode only when the orchestrator's request is purely flag-based (e.g., `--scope working-tree`).
- For `prompt` mode, ALWAYS use the heredoc + temp file pattern above. NEVER inline the prompt text in the bash command (Bash would evaluate metacharacters in the prompt body, which is a code-execution risk if the orchestrator's prompt contains untrusted content).
- Do not inspect the repository, read files, grep, or do any independent analysis.
- Do not call `setup` — that is user-facing only.
- Return the stdout of the companion command exactly as-is.
- If the Bash call fails or opencode cannot be invoked, return the stderr verbatim.

Response style:

- Do not add commentary before or after the forwarded `opencode-companion` output.
- The orchestrator parses the trailing `verdict:` line for routing decisions; do not reformat or strip it.
```

- [ ] **Step 2: Remove placeholder**

```bash
rm plugins/opencode/agents/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add plugins/opencode/agents/opencode-review.md
git rm plugins/opencode/agents/.gitkeep
git commit -m "feat(opencode): opencode-review subagent for programmatic dispatch"
```

---

## Phase 7 — End-to-end smoke tests against real opencode

### Task 7.1: Gated end-to-end test

**Files:**
- Create: `tests/opencode/e2e.test.mjs`

- [ ] **Step 1: Write the test**

`tests/opencode/e2e.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

const E2E_ENABLED = process.env.OPENCODE_E2E === "1";

test("e2e: real opencode review on a tiny diff produces a parseable verdict (no parse error)", { skip: !E2E_ENABLED }, async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "add.js"), "function add(a, b) { return a + b; }\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /verdict:\s+(approve|needs-attention)/);
    // Stronger assertion: the model honored the trailer, so no parse error appears.
    assert.doesNotMatch(result.stdout, /parse error/i,
      `model omitted the JSON trailer; full stdout: ${result.stdout}`);
    // And the trailer block itself was emitted in the original opencode output.
    assert.match(result.stdout, /```json/);
  } finally {
    cleanup();
  }
});

test("e2e: real opencode prompt forwarding produces a parseable verdict", { skip: !E2E_ENABLED }, async () => {
  const promptText = `Review this tiny snippet and reply with Markdown findings followed by a fenced JSON trailer.

\`\`\`js
function add(a, b) { return a + b; }
\`\`\`

Trailer format (verbatim):

\`\`\`json
{"verdict": "approve" | "needs-attention", "blockers": []}
\`\`\``;
  const result = await runCompanion(["prompt", promptText], {});
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /verdict:\s+(approve|needs-attention)/);
  assert.doesNotMatch(result.stdout, /parse error/i,
    `model omitted the JSON trailer for the prompt route; full stdout: ${result.stdout}`);
});

test("e2e: setup against the real binary reports installed", { skip: !E2E_ENABLED }, async () => {
  const result = await runCompanion(["setup"], {});
  assert.equal(result.code, 0);
  assert.match(result.stdout, /opencode is installed/i);
});
```

- [ ] **Step 2: Run gated**

Run: `node --test tests/opencode/e2e.test.mjs`

Expected: 3 tests skipped (because `OPENCODE_E2E` is not set).

- [ ] **Step 3: Run ungated locally**

Run: `OPENCODE_E2E=1 node --test tests/opencode/e2e.test.mjs`

Expected: 3 tests pass. The two opencode-invoking tests take ~5–30 seconds each depending on the configured model.

If the e2e test fails, capture the stderr and decide whether the failure is in the plugin (fix it) or in opencode itself / the configured provider (document and skip).

- [ ] **Step 4: Commit**

```bash
git add tests/opencode/e2e.test.mjs
git commit -m "test(opencode): gated end-to-end smoke tests against real opencode"
```

---

## Phase 8 — Plugin README + CHANGELOG + post-execution report

### Task 8.1: Plugin README

**Files:**
- Create: `plugins/opencode/README.md`

- [ ] **Step 1: Write the README**

`plugins/opencode/README.md`:

```markdown
# opencode plugin

Claude Code plugin that wraps the [opencode](https://opencode.ai) CLI as a third independent code-review agent.

## What this gives you

- **`/opencode:review`** — code review of the working tree or branch diff using whichever LLM you have configured in `~/.config/opencode/opencode.json`.
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
```

- [ ] **Step 2: Commit**

```bash
git add plugins/opencode/README.md
git commit -m "docs(opencode): plugin README"
```

### Task 8.2: Plugin CHANGELOG

**Files:**
- Create: `plugins/opencode/CHANGELOG.md`

- [ ] **Step 1: Write the changelog**

`plugins/opencode/CHANGELOG.md`:

```markdown
# Changelog

All notable changes to the opencode plugin are documented here.

## 0.1.0 — Initial scaffold (read-only review)

Implemented per `docs/plans/000-opencode-plugin-v1-scaffold.md`.

### Added
- `/opencode:review` slash command (foreground only).
- `/opencode:setup` slash command.
- `opencode:opencode-review` subagent for programmatic dispatch.
- Internal `opencode-cli-runtime` skill.
- Node companion script (`scripts/opencode-companion.mjs`) wrapping `opencode run --format json`.
- Hybrid output convention — Markdown findings + fenced JSON trailer for the verdict signal.
- `schemas/review-trailer.schema.json` documenting the trailer shape.
- Workspace-level `tests/` harness using `node:test`, with mock fixtures for the opencode binary and a gated end-to-end suite (`OPENCODE_E2E=1`).

### Deferred to future plans
- Write-capable rescue, background tasks, `/opencode:status` / `/opencode:result` / `/opencode:cancel` — plan 001.
- Adversarial-review and optional Stop-hook review gate — plan 002.
- Marketplace publishing — separate later plan.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/opencode/CHANGELOG.md
git commit -m "docs(opencode): plugin CHANGELOG"
```

### Task 8.3: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test passes (e2e tests skipped unless `OPENCODE_E2E=1`).

- [ ] **Step 2: Lint the plugin manifests**

Verify each Markdown file has valid frontmatter:

```bash
for f in plugins/opencode/commands/*.md plugins/opencode/agents/*.md plugins/opencode/skills/**/*.md; do
  echo "=== $f ==="
  head -1 "$f"
done
```

Expected: every file starts with `---`.

- [ ] **Step 3: Verify the plugin loads in Claude Code**

This is a manual step; it cannot be automated from inside this plan. Restart Claude Code and confirm `/opencode:review`, `/opencode:setup`, and the `opencode:opencode-review` subagent appear in the relevant lists.

- [ ] **Step 4: Write the post-execution report**

Append to this plan file under the `## Post-execution report` section (template at the end of this document) with:

- What was implemented vs the plan (note any deviations).
- Test counts (unit, integration, e2e).
- Known limitations.
- Follow-up items to surface in plan 001.

- [ ] **Step 5: Commit the post-execution report**

```bash
git add docs/plans/000-opencode-plugin-v1-scaffold.md
git commit -m "docs(plan-000): post-execution report"
```

### Task 8.4: Retire HANDOFF.md

This task runs *after* the post-execution report is written and committed (Task 8.3). Doing it last guarantees no information loss if execution stalls partway: the report supersedes HANDOFF.md, and the report exists in git before HANDOFF.md is deleted.

**Files:**
- Delete: `HANDOFF.md`

- [ ] **Step 1: Confirm the post-execution report is committed**

Run: `git log --oneline -5 docs/plans/000-opencode-plugin-v1-scaffold.md`

Expected: the most recent entry is the post-execution-report commit from Task 8.3.

- [ ] **Step 2: Confirm `docs/development-workflow.md` Session Handoff Rules cover recurring handoffs**

Run: `grep -n "Session Handoff Rules" docs/development-workflow.md`

Expected: matches the existing section. (This is a sanity check; the section was created in the bootstrap commit.)

- [ ] **Step 3: Delete and commit**

```bash
git rm HANDOFF.md
git commit -m "chore: retire HANDOFF.md (superseded by docs/development-workflow.md handoff rules and plan post-execution reports)"
```

---

## Codex review summary

### Round 1 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** Codex (gpt-5.5 via codex-companion)
**Findings:** 5 BLOCKERS, 7 SHOULD-FIX, 1 NICE-TO-HAVE

**Blockers**

1. `[FIXED]` Wrong opencode event shape — assumes `{type:"message", role:"assistant", content}` but actual opencode SDK emits `message.updated` / `message.part.updated` with text on `part.text`. Both reviewers confirmed empirically.
   → Resolution: Task 4.1 reworked — `parseEvents` reconstructs assistant text from `text`-typed events, grouping by `messageID`. Mock fixtures updated to emit the real event shape.

2. `[FIXED]` Plan-review gate routing broken — the subagent only forwards args to `review` (git-diff), but the orchestrator needs to ask free-form questions about a plan/spec file. Plan-review would silently degrade to a generic working-tree review.
   → Resolution: New `prompt` subcommand added (Task 4.3, free-form passthrough). The `opencode-review` subagent now calls `prompt`, accepting any free-form prompt text from the orchestrator. The `/opencode:review` slash command continues to call `review` (git-diff convenience). Both routes share `lib/invoke.mjs`.

3. `[FIXED]` `gitOutput` swallows errors → false approvals — invalid base refs, non-repo cwd, or buffer overflow all produce empty strings, which the caller interprets as "nothing to review → approve".
   → Resolution: Task 2.3 reworked — `runGit` returns `{ok, stdout, stderr, code}`. Callers propagate errors; `getDiff` failures are surfaced as invocation errors with `verdict: needs-attention`.

4. `[FIXED]` Untracked file content not actually read — `git show :0:<path>` only reads staged blobs and silently returns empty for untracked. Test only checks filenames, so it passes while omitting all content.
   → Resolution: Task 2.3 reworked — untracked files read from disk with `readFileSync`, gated by 1 MB size cap and a NUL-byte binary check (mirrors codex's pattern). Test updated to assert on file content, not just filename.

5. `[FIXED]` Shell injection from string interpolation — `execSync(\`git ${args.join(" ")}\`)` is unsafe with user-controlled `--base` and breaks on spaces/metacharacters in any path.
   → Resolution: All git invocations use `execFileSync("git", args, { shell: false })`. Same change applied in test helpers.

**Should-fix**

6. `[FIXED]` `$ARGUMENTS` unquoted in `/opencode:review`; companion can't parse a quoted single arg either. → Resolution: Quote `"$ARGUMENTS"` in slash command; companion splits internally with `splitArgs` helper.
7. `[FIXED]` CLAUDE.md "Do NOT delegate coding to opencode" becomes contradictory after plan 001. → Resolution: Task 1.2 expanded to also rewrite the "Coding Agent" and Don't sections to reflect the phased rollout.
8. `[FIXED]` Config path inconsistency — `~/.opencode/opencode.json` vs `~/.config/opencode/opencode.json`. → Resolution: spec, CLAUDE.md rewrite, and README all standardize on `~/.config/opencode/opencode.json` (the actual location). Implementation already correct.
9. `[FIXED]` Spec mandates "retry once on parse failure" but plan emits parse error immediately. → Resolution: Spec amended to remove the retry-once requirement; v1 uses single-pass parse with `needs-attention (parse error)` on failure. Retry deferred to plan 002 polish.
10. `[FIXED]` `invokeOpencode` has no timeout/kill path. → Resolution: Task 4.1 adds a `--timeout-ms` arg (default 300000) and an AbortController-driven kill. New test using a sleep fixture verifies the timeout path.
11. `[FIXED]` Schema (additionalProperties:false, minLength:1) stricter than handwritten validator. → Resolution: Task 2.4 validator updated to enforce both constraints; tests added.
12. `[FIXED]` Scaffold doesn't `mkdir` `scripts/lib/` or `tests/opencode/fixtures/` before first writes. → Resolution: Task 1.1 Step 2 expanded to include both subdirectories.

**Nice-to-have**

13. `[FIXED]` E2E test only checks for a verdict line, which can be produced even after parse failure. → Resolution: Task 7.1 e2e tests now assert that no parse-error string is present and that the original opencode output contained a parseable trailer.

### Round 2 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** Codex (gpt-5.5 via codex-companion)
**Findings:** 2 BLOCKERS, 4 SHOULD-FIX

**Blockers**

R2-1. `[FIXED]` `scope:auto` still falls through to `working-tree` when the working tree is clean and the base ref is missing, producing a false `verdict: approve (no changes)`. Round 1 fixed branch and explicit-branch paths but left the auto-with-clean-tree-and-bad-base path silent.
   → Resolution: Task 2.3 `resolveScope` now returns `fail(...)` when `scope=auto`, the working tree is clean, and the base ref does not exist. The error names the missing base and tells the user how to specify a valid one. New test added.

R2-2. `[FIXED]` Shell injection still possible via `$ARGUMENTS` interpolation in the slash command bash and the subagent's constructed bash. Quoting `"$ARGUMENTS"` prevents whitespace splitting but bash still evaluates command substitution (`` ` `` and `$()`), backticks, and quote escaping inside an unquoted prompt body. The subagent's free-form prompt route is most exposed because the orchestrator may construct prompts containing arbitrary text.
   → Resolution: Companion `prompt` subcommand now accepts `--prompt-file <path>`. The subagent (Task 6.2) now uses a heredoc with a quoted delimiter (`<<'OPENCODE_EOF'`) to write the prompt to a temp file, then passes the temp-file path to the companion — no shell interpolation of the prompt body. The slash command's `review` route stays on `"$ARGUMENTS"` because its arguments are flag-style (whitelisted by the companion's argument parser); a regression test asserts that unknown flag names are rejected.

**Should-fix**

R2-3. `[FIXED]` Spec says the `prompt` route prints raw text only when no trailer is present; plan implementation always calls `emitVerdictLines` and emits a parse-error verdict line. Both reviewers flagged this contract mismatch.
   → Resolution: Companion split into `emitTextOnly`, `emitTextWithVerdict` (always emits verdict), and `emitTextWithOptionalVerdict` (emits verdict only when trailer parses). `runReview` uses `WithVerdict`; `runPrompt` uses `WithOptionalVerdict`. Spec, skill doc, and tests aligned.
R2-4. `[FIXED]` Spec's capability table only lists `review` and `setup`, missing `prompt`; spec contradicts implementation on exit-code semantics (spec says non-zero on unrecoverable errors, implementation always exits 0 with stdout verdicts except for argument errors).
   → Resolution: Spec capability table updated to list all three subcommands; spec's exit-code section rewritten to match implementation (exit 0 for all runtime conditions including missing binary / git error / parse error, since downstream consumers route on the verdict line; exit 2 only for argument-parse errors).
R2-5. `[FIXED]` Timeout test only proves SIGTERM-respecting termination; SIGKILL escalation untested.
   → Resolution: Added `mock-opencode-stubborn-sleep.mjs` fixture that ignores SIGTERM; new test verifies the process is SIGKILLed within ~3 seconds of timeout.
R2-6. `[FIXED]` `parseEvents` picks "final" message by first-seen messageID order, which can be wrong if a later event appends to an earlier message after another messageID first appears.
   → Resolution: Updated to track per-messageID `lastIdx`; final message = highest `lastIdx`. New `mock-opencode-multi-message.mjs` fixture with two interleaved messageIDs; test asserts the message whose last text event arrived latest wins.

### Round 3 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** Codex (gpt-5.5 via codex-companion)
**Findings:** 1 BLOCKER, 3 SHOULD-FIX

**Blocker**

R3-1. `[FIXED]` Heredoc delimiter collision still permits prompt breakout — if the orchestrator's prompt contains a bare line equal to `OPENCODE_EOF`, the heredoc terminates early and subsequent prompt lines execute as shell commands.
   → Resolution: Subagent uses a long, high-entropy literal delimiter (`OPENCODE_PROMPT_DELIMITER_DO_NOT_USE_IN_PROMPT_xK7p2qR9_END`) AND the skill+subagent body explicitly require the subagent to verify the prompt body does not contain that literal string before constructing the heredoc. The companion's `--prompt-file` mode is also restricted to paths under `$TMPDIR/opencode-prompts/` so even a successful breakout cannot read arbitrary files (defense in depth). The probability of accidental collision with a 9-char random suffix is ~10^-13.

**Should-fix**

R3-2. `[FIXED]` `prompt` route trims input — silently strips leading/trailing whitespace, contradicting the spec's "verbatim" guarantee.
   → Resolution: `runPrompt` only uses `.trim()` for the empty-prompt guard; the original `input.text` (untrimmed) is passed to `invokeOpencode`.
R3-3. `[FIXED]` SIGKILL escalation test bound (`<5000`) is too loose — would not catch a ~1.5s regression in the kill-grace window.
   → Resolution: Bound tightened to `<3500` ms with a comment naming the constants (`timeoutMs=500 + killGraceMs=2000 + slack=1000`).
R3-4. `[FIXED]` Review-route flag handling inconsistent — R2-2 summary claimed unknown flags are rejected, but `parseReviewArgs` silently ignores them and the slash command doc says flags are "ignored (forward-compat)".
   → Resolution: `parseReviewArgs` now rejects unknown flags with exit 2 and an error message naming the unknown flag. The `/opencode:review` slash command doc and the review-cmd test updated to match. Forward-compat unknown flags are NOT supported in plan 000 — they will be added explicitly when introduced.

### Round 4 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** Codex (gpt-5.5 via codex-companion)
**Findings:** 0 BLOCKERS, 2 SHOULD-FIX (no NEW blockers — all R3 blockers verified)

**Should-fix**

R4-1. `[FIXED]` The Round 3 opencode review summary's resolution text says the subagent uses `mktemp -d` "rooted at `$TMPDIR/opencode-prompts-$$/`" but the actual subagent body uses `$TMPDIR/opencode-prompts/` (no `-$$/` suffix; `mktemp -d` creates a `run-XXXXXX` subdirectory inside that base). Companion only allows the unsuffixed form.
   → Resolution: Round 3 opencode summary text corrected to match the actual code (`$TMPDIR/opencode-prompts/run-XXXXXX/`).
R4-2. `[FIXED]` `--stdin` is still listed in the `opencode-cli-runtime` skill doc as a supported "other input mode" even though the companion now rejects it.
   → Resolution: Skill doc updated — `--stdin` line replaced with a note that stdin is explicitly unsupported in plan 000.

### Round 5 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** Codex (gpt-5.5 via codex-companion)
**Findings:** 2 BLOCKERS, 4 SHOULD-FIX (Round 5 reviews the user-requested model-selection feature plus R4 follow-throughs)

**Blockers**

R5-1. `[FIXED]` Task 5.2 execution `review --model "$CHOSEN_MODEL" "$ARGUMENTS"` breaks `parseReviewArgs` when `$ARGUMENTS` is non-empty multi-token. With `$ARGUMENTS = "--scope working-tree"`, the bash invocation produces `argv = ["--model", "X", "--scope working-tree"]` (length 3). The previous `parseReviewArgs` only ran `splitArgs` when `rawArgs.length === 1`, so `"--scope working-tree"` reached the loop as a literal unknown-flag-looking token and failed validation.
   → Resolution: `parseReviewArgs` updated to `flatMap(a => splitArgs(a))` across every input element. Idempotent on already-split single tokens. New regression tests cover the mixed multi-arg + quoted-string case AND the last-occurrence-wins behavior for duplicate `--model` flags.
R5-2. `[FIXED]` Same issue surfaces under "what happens when $ARGUMENTS itself contains --model" — execution still injected `--model "$CHOSEN_MODEL"` even though the user supplied one.
   → Resolution: Slash command body now branches: if `$ARGUMENTS` already contains `--model`, skip the picker AND skip injection (run `review "$ARGUMENTS"` unchanged). The picker only runs when no user-supplied model is detected.

**Should-fix**

R5-3. `[FIXED]` Free-text fallback for AskUserQuestion option overflow not specified.
   → Resolution: Slash command body now spells out the exact behavior: ≤4 models → present all; >4 models → present first 3 + `Other (specify model id)` which triggers a follow-up free-text question, validated against `companion models` output (one retry on validation failure, then bail out).
R5-4. `[FIXED]` AskUserQuestion option limit not stated.
   → Resolution: Stated as 4 in slash command body.
R5-5. `[FIXED]` Subagent docs do not explain how an orchestrator passes a model — `runPrompt` only honored `OPENCODE_MODEL` env var.
   → Resolution: `parsePromptArgs` now accepts `--model <provider/model>` flag (with precedence: `--model` > `OPENCODE_MODEL` env > config default). Subagent body documents the optional `--model` argument with example.
R5-6. `[FIXED]` No explicit guard against `companion review` running with `$CHOSEN_MODEL` unset.
   → Resolution: Slash command body explicitly states: if `$CHOSEN_MODEL` is empty after the picker (cancelled, validation failed twice), stop without invoking review and surface "model selection cancelled".

### Round 6 — 2026-05-03

**Verdict:** APPROVE
**Reviewer:** Codex (gpt-5.5 via codex-companion)
**Findings:** 0 BLOCKERS, 0 SHOULD-FIX, 0 NICE-TO-HAVE

All Round 5 findings (Codex R5-1 through R5-6 plus opencode R5's path-prose catch) verified resolved. No new issues introduced. Plan ready for user approval.

---

## Opencode review summary

### Round 1 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** opencode (volcengine-plan/glm-4.7)
**Findings:** 1 BLOCKER, 3 SHOULD-FIX, 3 NICE-TO-HAVE

**Blocker**

1. `[FIXED]` Wrong opencode event format (corroborates Codex finding #1; reviewer ran `opencode run --format json` empirically and dumped real event shape). → Resolution: same as Codex #1 above.

**Should-fix**

2. `[FIXED]` Missing `hooks/` and `prompts/` directories from scaffold — codex reference plugin includes them. → Resolution: Task 1.1 adds an explicit note documenting why these are deferred (hooks ship with plan 001 alongside background tasks; prompts ship with plan 002 alongside adversarial-review).
3. `[FIXED]` HANDOFF.md deletion timing risk — currently in Task 8.3 before the post-execution report commit (Task 8.4 Step 5). If execution fails between, HANDOFF.md is gone. → Resolution: HANDOFF.md retirement moved to *after* the post-execution-report commit (now Task 8.4, with the post-execution report at Task 8.3).
4. `[FIXED]` Schema divergence from codex (codex has rich findings array; opencode minimal). → Resolution: Spec amended to document the explicit tradeoff (model-agnostic reliability over rich structure) in a new "Why a minimal trailer schema?" subsection.

**Nice-to-have**

5. `[WONTFIX in plan 000]` Non-UTF8 content handling. → Resolution: Documented as a known limitation in plugin README; tracked for plan 002 polish phase.
6. `[WONTFIX in plan 000]` PATH edge cases (multi-dir PATH, no-execute permission, dead symlinks). → Resolution: Documented as a known limitation; tracked for plan 002.
7. `[WONTFIX in plan 000]` Parameter naming inconsistency between `cli-detection` (`env` object) and `config-detection` (`configPath`). → Resolution: Intentional — they're different kinds of input (process env vs. file path). No change.

### Round 2 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** opencode (volcengine-plan/glm-4.7)
**Findings:** 0 BLOCKERS, 2 SHOULD-FIX

**Should-fix**

R2-1. `[FIXED]` Spec/plan ambiguity on prompt subcommand verdict behavior — same finding as Codex R2-3 (both reviewers caught it independently).
   → Resolution: Same as Codex R2-3.
R2-2. `[FIXED]` Typo in Round 1 review summary — "now Task 8.5" should be "now Task 8.4".
   → Resolution: Typo corrected.

### Round 3 — 2026-05-03

**Verdict:** NEEDS-REVISION
**Reviewer:** opencode (volcengine-plan/glm-4.7)
**Findings:** 2 BLOCKERS, 1 NICE-TO-HAVE

**Blockers**

R3-1. `[FIXED]` Path traversal in `--prompt-file` — companion accepts any absolute or relative path with no validation; a malicious orchestrator could request `--prompt-file /etc/passwd` and leak its contents through the opencode response.
   → Resolution: Companion validates that `--prompt-file <path>` resolves (via `realpath`-equivalent `fs.realpathSync`) to a path under `$TMPDIR/opencode-prompts/` (default `/tmp/opencode-prompts/` if `$TMPDIR` is unset). Out-of-bounds paths are rejected with exit 2. The subagent uses `mktemp -d "$TMPDIR/opencode-prompts/run-XXXXXX"` so its prompt files always live at `$TMPDIR/opencode-prompts/run-XXXXXX/prompt.txt` and satisfy the constraint. New tests assert that traversal attempts (`../`, `/etc/passwd`, paths outside the allowed dir) are rejected.
R3-2. `[FIXED]` `--stdin` mode enables arbitrary file reads via shell redirection (e.g., `cat /etc/passwd | companion prompt --stdin`).
   → Resolution: `--stdin` removed from plan 000. Only `--prompt-file <path-under-allowed-dir>` and positional args are supported. If a future plan needs stdin (e.g., for shell pipelines), it can re-add the flag with an explicit opt-in env guard.

**Nice-to-have**

R3-3. `[FIXED]` No tests for path-traversal attempts on `--prompt-file`.
   → Resolution: Added negative tests for `..`-relative paths, absolute paths outside the allowed dir, and `/etc/passwd`-style sensitive paths. All must be rejected before any file read is attempted.

### Round 4 — 2026-05-03

**Verdict:** APPROVE (with 1 SHOULD-FIX, 1 NICE-TO-HAVE)
**Reviewer:** opencode (volcengine-plan/glm-4.7)
**Findings:** 0 BLOCKERS, 1 SHOULD-FIX, 1 NICE-TO-HAVE

opencode verified all Round 3 BLOCKERS are resolved (path traversal, --stdin removal, heredoc collision). Same `--stdin` skill-doc finding as Codex R4-2 — addressed jointly.

**Should-fix**

R4-1. `[FIXED]` Same as Codex R4-2 — `opencode-cli-runtime` skill doc still lists `--stdin`.
   → Resolution: handled in Codex R4-2.

**Nice-to-have**

R4-2. `[FIXED]` `allowedPromptDir()` lacks try/catch around `realpathSync($TMPDIR)` — a broken `$TMPDIR` symlink crashes the process. Crash is safe (no data leaked) but unfriendly.
   → Resolution: `allowedPromptDir()` wrapped in try/catch with fallback to `/tmp/opencode-prompts` if `$TMPDIR` cannot be resolved.

### Round 5 — 2026-05-03

**Verdict:** NEEDS-REVISION (1 BLOCKER, 1 SHOULD-FIX, 3 NICE-TO-HAVE — first opencode pass hung after 14 min and was killed; this verdict is from a second attempt with a tighter prompt)
**Reviewer:** opencode (volcengine-plan/deepseek-v4-flash — model auto-selected on retry)
**Findings:** 1 BLOCKER, 1 SHOULD-FIX, 3 NICE-TO-HAVE (the latter all "verified, no issue")

**Blocker**

R5-1. `[FIXED]` Stale `$TMPDIR/opencode-prompts-$$/` text remains in the subagent body prose at Task 6.2 even though the bash code block immediately below correctly uses `$TMPDIR/opencode-prompts/`. R4-1 corrected the summary text but missed the prose. A subagent following the prose would create a temp file in a directory the companion's `--prompt-file` validator rejects.
   → Resolution: Subagent body prose updated to read `$TMPDIR/opencode-prompts/run-XXXXXX/`, matching the bash code block.

**Should-fix**

R5-2. `[FIXED]` The model picker's "Other" free-text validation flow does not specify whether to re-run `companion models` or use the cached output from the initial listing.
   → Resolution: Slash command body explicitly states the validation uses the same `companion models` output captured at step 2 — no second invocation needed (Claude holds it in context).

**Nice-to-have (no fix needed)**

R5-3. `parseReviewArgs` `flatMap(splitArgs)` design verified correct.
R5-4. `parsePromptArgs` `--model` plumbing verified correct (precedence `--model > OPENCODE_MODEL > config default`).
R5-5. Tasks 2.5b / 3.4 / 5.2 design coherence verified.

### Round 6 — 2026-05-03

**Verdict:** APPROVE
**Reviewer:** opencode (volcengine-plan/deepseek-v4-flash)
**Findings:** 0 BLOCKERS, 0 SHOULD-FIX, 0 NICE-TO-HAVE

All R5 fixes verified intact (path prose, cached models output, parseReviewArgs flatMap, slash command branching, parsePromptArgs --model, $CHOSEN_MODEL guard). No regressions, no stale references, no new issues. Plan ready for user approval.

---

## Code Review

(Filled in during Step 5 of `docs/development-workflow.md`. Format per `docs/code-review.md`.)

---

## Post-execution report

(Filled in at the end of execution per Phase 8, Task 8.3. Followed by HANDOFF.md retirement in Task 8.4.)
