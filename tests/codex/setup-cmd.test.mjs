// Plan-007 Phase 2 tests for /codex:setup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCompanion } from "./helpers.mjs";

const SUCCESS_BIN = resolve("tests/codex/fixtures/mock-codex-success.mjs");

function makeTempCodexHome(modelLine = `model = "gpt-5"\n`) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), modelLine);
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("setup reports installed + configured when codex bin and config are present", async () => {
  const { home, cleanup } = makeTempCodexHome();
  try {
    const result = await runCompanion(["setup"], {
      CODEX_BIN: SUCCESS_BIN,
      CODEX_HOME: home,
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /✓ codex installed/);
    assert.match(result.stdout, /✓ default model configured: gpt-5/);
  } finally {
    cleanup();
  }
});

test("setup reports 'not installed' guidance when CODEX_BIN doesn't exist", async () => {
  const result = await runCompanion(["setup"], {
    CODEX_BIN: "/nonexistent/codex",
    PATH: "/nonexistent",
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /codex is not installed/i);
  // Install guidance lists the well-known scan paths.
  assert.match(result.stdout, /\.codex\/bin\/codex/);
  assert.match(result.stdout, /CODEX_BIN/);
});

test("setup reports missing model when config has no top-level model = field", async () => {
  const { home, cleanup } = makeTempCodexHome(`# config.toml with no model\n[features]\nfoo = true\n`);
  try {
    const result = await runCompanion(["setup"], {
      CODEX_BIN: SUCCESS_BIN,
      CODEX_HOME: home,
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /✓ codex installed/);
    assert.match(result.stdout, /no top-level `model` field/);
  } finally {
    cleanup();
  }
});

test("models lists the configured default first then well-known fallbacks", async () => {
  const { home, cleanup } = makeTempCodexHome(`model = "gpt-5"\n`);
  try {
    const result = await runCompanion(["models"], {
      CODEX_BIN: SUCCESS_BIN,
      CODEX_HOME: home,
    });
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines[0], "gpt-5", "default must appear first");
    assert.ok(lines.includes("o3"), "well-known list includes o3");
    assert.ok(lines.includes("o4"), "well-known list includes o4");
  } finally {
    cleanup();
  }
});
