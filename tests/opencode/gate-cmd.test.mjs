import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompanion, makeTempRepo } from "./helpers.mjs";
import { loadConfig, updateConfig } from "../../plugins/opencode/scripts/lib/config.mjs";

test("gate status: reports OFF by default", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate", "status"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /OFF/);
  } finally { cleanup(); }
});

test("gate on: sets stopReviewGate true and persists", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    await runCompanion(["gate", "on"], { CLAUDE_PROJECT_DIR: dir });
    const r = loadConfig(dir);
    assert.equal(r.value.stopReviewGate, true);
  } finally { cleanup(); }
});

test("gate off: sets stopReviewGate false and persists", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    updateConfig(dir, { stopReviewGate: true });
    await runCompanion(["gate", "off"], { CLAUDE_PROJECT_DIR: dir });
    const r = loadConfig(dir);
    assert.equal(r.value.stopReviewGate, false);
  } finally { cleanup(); }
});

test("gate (no arg): defaults to status", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /OFF|ON/);
  } finally { cleanup(); }
});

test("gate <unknown>: rejected with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate", "ninja"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown gate action/i);
  } finally { cleanup(); }
});

test("gate on extra-arg: rejected with exit 2 (catch typos like 'gate on off')", async () => {
  // Codex + glm code review: extra positional args were silently ignored,
  // so /opencode:gate on off would silently succeed as 'on'.
  const { dir, cleanup } = makeTempRepo();
  try {
    const result = await runCompanion(["gate", "on", "off"], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /at most one argument/i);
  } finally { cleanup(); }
});
