// Plan-006 Phase 3 (C1). Verifies the .catch() wrappers on the top-level
// async dispatches in buddy.mjs handle unhandled rejections cleanly (exit 2
// with a clear stderr message) instead of crashing Node with exit 1 from
// an unhandled-rejection event.
//
// Test seam: OPENCODE_BUDDY_TEST_THROW=<runnerName> triggers a throw at the
// top of the matching runner. Documented as test-only in the plugin README.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

test("runReview unhandled rejection is caught by top-level .catch (exits 2, not 1)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_BUDDY_TEST_THROW: "runReview", OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2, `expected exit 2 from .catch handler; got ${result.code}; stderr: ${result.stderr}`);
    assert.match(result.stderr, /unhandled error in review/i);
    assert.match(result.stderr, /OPENCODE_BUDDY_TEST_THROW=runReview simulated failure/);
  } finally {
    cleanup();
  }
});

test("runPrompt unhandled rejection is caught by top-level .catch (exits 2, not 1)", async () => {
  const result = await runCompanion(
    ["prompt", "hello"],
    { OPENCODE_BUDDY_TEST_THROW: "runPrompt" },
  );
  assert.equal(result.code, 2, `expected exit 2; got ${result.code}; stderr: ${result.stderr}`);
  assert.match(result.stderr, /unhandled error in prompt/i);
  assert.match(result.stderr, /OPENCODE_BUDDY_TEST_THROW=runPrompt simulated failure/);
});

test("runRun unhandled rejection is caught by top-level .catch (exits 2, not 1)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(
      ["run", "--task", "x", "--yolo"],
      { OPENCODE_BUDDY_TEST_THROW: "runRun", OPENCODE_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
    );
    assert.equal(result.code, 2, `expected exit 2; got ${result.code}; stderr: ${result.stderr}`);
    assert.match(result.stderr, /unhandled error in run/i);
    assert.match(result.stderr, /OPENCODE_BUDDY_TEST_THROW=runRun simulated failure/);
  } finally {
    cleanup();
  }
});

test("OPENCODE_BUDDY_TEST_THROW unset → no behavior change (review subcommand exits normally)", async () => {
  // Sanity check: the test seam doesn't activate in production. When the env
  // var is unset, runReview proceeds normally and the .catch handler doesn't
  // fire (we know from existing review-cmd tests that this path exits 0).
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_REPO_ROOT: dir, OPENCODE_BIN: "/nonexistent/opencode", PATH: "/nonexistent" },
    );
    // OPENCODE_BIN points to a missing binary, so detectOpencode reports
    // not-installed and the runner exits 0 with the install guidance.
    assert.equal(result.code, 0);
    assert.match(result.stdout, /not installed/i);
    // Crucially: no "unhandled error in review" line in stderr.
    assert.doesNotMatch(result.stderr, /unhandled error/);
  } finally {
    cleanup();
  }
});
