import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeTempRepo } from "./helpers.mjs";
import { updateConfig } from "../../plugins/opencode/scripts/lib/config.mjs";

const HOOK_SCRIPT = resolve("plugins/opencode/scripts/stop-review-gate-hook.mjs");
const REVIEW_OK_BIN = resolve("tests/opencode/fixtures/mock-opencode-success.mjs");
const REVIEW_NEEDS_ATTN_BIN = resolve("tests/opencode/fixtures/mock-opencode-review-needs-attention.mjs");
const REVIEW_NO_TRAILER_BIN = resolve("tests/opencode/fixtures/mock-opencode-review-no-trailer.mjs");

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}
function setupRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "commit", "--allow-empty", "-m", "init", "-q");
}

// Add `.claudecode-buddy/` to gitignore so the dispatcher's runtime state
// doesn't show as untracked. Matches D-008's production convention. Used by
// tests that need a clean working tree as the baseline.
function gitignoreBuddyDir(dir) {
  writeFileSync(join(dir, ".gitignore"), ".claudecode-buddy/\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-m", "gitignore .claudecode-buddy/", "-q");
}

function runHook(input, env = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

test("stop-gate: returns silently when stopReviewGate is OFF (default)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "done",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "no JSON decision emitted when gate is OFF");
  } finally { cleanup(); }
});

test("stop-gate: smart-skip when working tree is clean (no git changes)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    gitignoreBuddyDir(dir);
    updateConfig(dir, { stopReviewGate: true });
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Here's how the function works...",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "smart-skip must NOT emit a block decision");
    assert.match(result.stderr, /skipping.*no.*changes/i);
  } finally { cleanup(); }
});

test("stop-gate: actionable turn (working tree dirty) → review invoked → approve passes", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "new.js"), "console.log('hi');\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "I added new.js.",
    }, { OPENCODE_BIN: REVIEW_OK_BIN });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "approve verdict must NOT block");
  } finally { cleanup(); }
});

test("stop-gate: meta-skip when only changes are under .claudecode-buddy/", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    mkdirSync(join(dir, ".claudecode-buddy", "opencode", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".claudecode-buddy", "opencode", "sessions", "plan-001-review-vendor-m.session-id"), "ses_xyz");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Reviewed the diff.",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "meta-skip must NOT emit a block decision");
    assert.match(result.stderr, /\.claudecode-buddy/i);
  } finally { cleanup(); }
});

test("stop-gate: working tree dirty AND assistant mentions review-dispatch → gate STILL runs", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "new.js"), "// real edits\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Dispatching opencode review for plan-001 round 2...",
    }, { OPENCODE_BIN: REVIEW_OK_BIN });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "approve fixture → no block decision");
    assert.doesNotMatch(result.stderr, /dispatching opencode reviewers/i,
      "round-2 dropped the soft-skip; this stderr message must not appear");
  } finally { cleanup(); }
});

test("stop-gate: needs-attention verdict → emit {decision:'block', reason}", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "broken.js"), "syntax error here\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    }, { OPENCODE_BIN: REVIEW_NEEDS_ATTN_BIN });
    assert.equal(result.code, 0);
    const decision = JSON.parse(result.stdout.trim());
    assert.equal(decision.decision, "block");
    assert.ok(decision.reason.length > 0);
  } finally { cleanup(); }
});

test("stop-gate: review invocation fails → fail OPEN (no block)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "x.js"), "x\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    }, { OPENCODE_BIN: "/nonexistent/binary" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "",
      "fail-open: broken review system must NOT block the user; only log warning");
  } finally { cleanup(); }
});

test("stop-gate: non-git workspace → gate runs (treated as actionable per D-011)", async () => {
  // Missing test flagged by codex + glm code review. Verifies the
  // existsSync(.git) pre-check branch where the gate runs WITHOUT a
  // git-state filter (the reviewer falls back to filesystem inspection).
  const { dir, cleanup } = makeTempRepo();
  try {
    // No setupRepo() — dir has no .git/.
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "code.js"), "// some code\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Wrote code.js.",
    }, { OPENCODE_BIN: REVIEW_OK_BIN });
    // Gate runs (not skipped) → review fixture emits approve → no block.
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "approve fixture in non-git workspace → no block");
    // The skip messages (no .git, clean tree, meta-skip) must NOT appear.
    assert.doesNotMatch(result.stderr, /skipping gate/i,
      "non-git workspace should NOT trigger any smart-skip path");
  } finally { cleanup(); }
});

test("stop-gate: invalid stopReviewGate type in config → falls back to default OFF", async () => {
  // Codex code review: manually-edited '{"stopReviewGate":"false"}' (string)
  // would have been truthy and enabled the gate without type validation.
  // Verify per-key validator drops the bad value and falls back to default.
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    gitignoreBuddyDir(dir);
    // Write a bogus config directly: stopReviewGate as a STRING, not boolean.
    const cfgDir = join(dir, ".claudecode-buddy", "opencode");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ stopReviewGate: "true" }));
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    });
    // Validator rejects the string, falls back to default false → gate is OFF
    // → hook returns silently (no review run).
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid type for "stopReviewGate"/i,
      "validator must warn about the type mismatch");
  } finally { cleanup(); }
});

test("stop-gate: trailer-parse failure → fail OPEN", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    updateConfig(dir, { stopReviewGate: true });
    writeFileSync(join(dir, "x.js"), "x\n");
    const result = await runHook({
      cwd: dir,
      session_id: "test",
      last_assistant_message: "Done.",
    }, { OPENCODE_BIN: REVIEW_NO_TRAILER_BIN });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /trailer.*parse|failing open|verdict/i);
  } finally { cleanup(); }
});
