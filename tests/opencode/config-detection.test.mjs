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
