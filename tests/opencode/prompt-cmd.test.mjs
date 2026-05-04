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

test("prompt does NOT synthesize a verdict line when the model omits the trailer", async () => {
  const result = await runCompanion(
    ["prompt", "Some free-form question with no trailer requested"],
    { OPENCODE_BIN: MALFORMED_BIN },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /I refuse/);
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

test("prompt preserves leading and trailing whitespace verbatim (no .trim before forwarding)", async () => {
  const { dir: tmpdir, cleanup } = makeTempRepo();
  try {
    const promptDir = join(tmpdir, "opencode-prompts");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = join(promptDir, "prompt.txt");
    writeFileSync(promptPath, "   leading space\nbody\ntrailing newlines\n\n\n");
    const result = await runCompanion(
      ["prompt", "--prompt-file", promptPath],
      { OPENCODE_BIN: SUCCESS_BIN, TMPDIR: tmpdir },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Looks fine/);
  } finally {
    cleanup();
  }
});
