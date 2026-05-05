import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  updateConfig,
} from "../../plugins/opencode/scripts/lib/config.mjs";
import { makeTempRepo } from "./helpers.mjs";

test("DEFAULT_CONFIG: stopReviewGate is false", () => {
  assert.equal(DEFAULT_CONFIG.stopReviewGate, false);
});

test("configPath: composes <projectDir>/.claudecode-buddy/opencode/config.json", () => {
  assert.equal(
    configPath("/tmp/x"),
    "/tmp/x/.claudecode-buddy/opencode/config.json",
  );
});

test("loadConfig: returns DEFAULT_CONFIG when file does not exist", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, DEFAULT_CONFIG);
  } finally { cleanup(); }
});

test("loadConfig: merges user values with defaults", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    updateConfig(dir, { stopReviewGate: true });
    const r = loadConfig(dir);
    assert.equal(r.value.stopReviewGate, true);
  } finally { cleanup(); }
});

test("loadConfig: non-JSON file → DEFAULT_CONFIG with warning (no error)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const path = configPath(dir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not json {");
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, DEFAULT_CONFIG);
  } finally { cleanup(); }
});

test("loadConfig: JSON-but-not-object → DEFAULT_CONFIG", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const path = configPath(dir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "[1,2,3]");
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, DEFAULT_CONFIG);
  } finally { cleanup(); }
});

test("updateConfig: round-trip", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const r1 = updateConfig(dir, { stopReviewGate: true });
    assert.equal(r1.ok, true);
    assert.equal(r1.value.stopReviewGate, true);
    const r2 = loadConfig(dir);
    assert.equal(r2.value.stopReviewGate, true);
    const r3 = updateConfig(dir, { stopReviewGate: false });
    assert.equal(r3.value.stopReviewGate, false);
  } finally { cleanup(); }
});

test("updateConfig: rejects non-object patch", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    assert.equal(updateConfig(dir, null).ok, false);
    assert.equal(updateConfig(dir, [1]).ok, false);
    assert.equal(updateConfig(dir, "foo").ok, false);
  } finally { cleanup(); }
});

test("updateConfig: atomic (no .tmp leftovers on success)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    updateConfig(dir, { stopReviewGate: true });
    const cfgDir = join(dir, ".claudecode-buddy", "opencode");
    const entries = readdirSync(cfgDir);
    assert.equal(entries.filter((e) => e.includes(".tmp.")).length, 0);
  } finally { cleanup(); }
});

test("loadConfig: invalid stopReviewGate type → falls back to default with warning (codex code review)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const path = configPath(dir);
    mkdirSync(join(path, ".."), { recursive: true });
    // String "true" — would have been truthy in `if (cfg.stopReviewGate)`,
    // enabling the gate when user clearly intended to disable it.
    writeFileSync(path, JSON.stringify({ stopReviewGate: "true" }));
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.equal(r.value.stopReviewGate, false,
      "validator must drop the string and fall back to default false");
  } finally { cleanup(); }
});

test("loadConfig: invalid type in unknown key → preserves the value (forward-compat)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const path = configPath(dir);
    mkdirSync(join(path, ".."), { recursive: true });
    // futureFlag is not in VALIDATORS → no validation → user value passes through.
    writeFileSync(path, JSON.stringify({ stopReviewGate: false, futureFlag: "anything" }));
    const r = loadConfig(dir);
    assert.equal(r.ok, true);
    assert.equal(r.value.futureFlag, "anything");
  } finally { cleanup(); }
});

test("updateConfig: preserves unrelated keys when patching one", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const path = configPath(dir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ stopReviewGate: false, futureFlag: 42 }));
    const r = updateConfig(dir, { stopReviewGate: true });
    assert.equal(r.value.stopReviewGate, true);
    assert.equal(r.value.futureFlag, 42, "unrelated keys must survive partial update");
  } finally { cleanup(); }
});
