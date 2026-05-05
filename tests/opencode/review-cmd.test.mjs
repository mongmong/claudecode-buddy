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

test("review --style adversarial accepted by parser", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree", "--style", "adversarial"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /verdict/i);
  } finally {
    cleanup();
  }
});

test("review --style friendly is the default + idempotent (same as no flag)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree", "--style", "friendly"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0);
  } finally {
    cleanup();
  }
});

test("review --style with invalid value rejected with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--style", "ninja"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--style.*friendly|adversarial/i);
  } finally {
    cleanup();
  }
});

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

test("review rejects --scope with no value (trailing flag) with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--scope"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--scope requires a value/i);
  } finally {
    cleanup();
  }
});

test("review rejects --base with no value with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--scope", "auto", "--base"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--base requires a value/i);
  } finally {
    cleanup();
  }
});

test("review rejects --model with no value with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--model"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--model requires a value/i);
  } finally {
    cleanup();
  }
});

test("review rejects --scope value not in {auto, working-tree, branch} with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["review", "--scope", "brnach"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--scope value must be one of/i);
    assert.match(result.stderr, /brnach/);
  } finally {
    cleanup();
  }
});

test("review honors last-occurrence wins for --model when injected and user-supplied both present", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--model", "injected/model", "--scope working-tree --model user/explicit"],
      { OPENCODE_BIN: SUCCESS_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /verdict.*approve/i);
  } finally {
    cleanup();
  }
});
