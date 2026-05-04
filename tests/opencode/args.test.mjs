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
  const arr = ["--scope", "branch"];
  assert.deepEqual(splitArgs(arr), arr);
});
