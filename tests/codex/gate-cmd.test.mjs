// Plan-007 Phase 5 tests for /codex:gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { loadConfig } from "../../plugins/codex/scripts/lib/config.mjs";

test("gate status defaults to OFF when no config exists", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate", "status"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Stop-hook review gate: OFF/);
  } finally {
    cleanup();
  }
});

test("gate on writes config + reflects ON on subsequent status", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const on = await runCompanion(["gate", "on"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(on.code, 0);
    assert.match(on.stdout, /Stop-hook review gate: ON/);
    const cfg = loadConfig(dir);
    assert.equal(cfg.ok, true);
    assert.equal(cfg.value.gate.enabled, true);
    const status = await runCompanion(["gate", "status"], { CLAUDE_PROJECT_DIR: dir });
    assert.match(status.stdout, /Stop-hook review gate: ON/);
  } finally {
    cleanup();
  }
});

test("gate off toggles back to disabled", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    await runCompanion(["gate", "on"], { CLAUDE_PROJECT_DIR: dir });
    const off = await runCompanion(["gate", "off"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(off.code, 0);
    assert.match(off.stdout, /Stop-hook review gate: OFF/);
    const status = await runCompanion(["gate", "status"], { CLAUDE_PROJECT_DIR: dir });
    assert.match(status.stdout, /Stop-hook review gate: OFF/);
  } finally {
    cleanup();
  }
});

test("gate with unknown action exits 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate", "yolo"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown gate action.*Use: on, off, status/);
  } finally {
    cleanup();
  }
});

test("gate with extra arguments exits 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate", "on", "extra"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /at most one argument/);
  } finally {
    cleanup();
  }
});
