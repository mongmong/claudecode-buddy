// Plan-007 Phase 2 — codex-specific cli-detection. Mirrors opencode's
// cli-detection tests but with the codex binary name + paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCodex, WELL_KNOWN_INSTALL_PATHS } from "../../plugins/codex/scripts/lib/cli-detection.mjs";

const FAKE_CODEX = `#!/bin/sh
[ "$1" = "--version" ] && echo "fake-codex 0.0.0" && exit 0
exit 0
`;

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "fake-home-"));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function dropFakeBinary(home, relPath) {
  const fullPath = relPath.startsWith("~/") ? join(home, relPath.slice(2)) : relPath;
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, FAKE_CODEX);
  chmodSync(fullPath, 0o755);
  return fullPath;
}

test("detectCodex reports installed when CODEX_BIN points to a valid binary", () => {
  const result = detectCodex({ env: { CODEX_BIN: "/usr/bin/true", PATH: process.env.PATH } });
  assert.equal(result.installed, true);
});

test("detectCodex falls back to ~/.codex/bin/codex when not on PATH", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    const fakeBin = dropFakeBinary(home, "~/.codex/bin/codex");
    const result = detectCodex({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, true);
    assert.equal(result.binary, fakeBin);
    assert.match(result.version, /fake-codex/);
  } finally {
    cleanup();
  }
});

test("detectCodex returns 'not installed' guidance when nothing found", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    const result = detectCodex({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, false);
    assert.match(result.guidance, /codex is not installed/i);
    assert.match(result.guidance, /CODEX_BIN/);
    assert.match(result.guidance, /\.codex\/bin\/codex/);
  } finally {
    cleanup();
  }
});

test("CODEX_BIN takes precedence over the well-known scan", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    dropFakeBinary(home, "~/.codex/bin/codex");
    const result = detectCodex({
      env: { CODEX_BIN: "/usr/bin/true", PATH: "/nonexistent", HOME: home },
    });
    assert.equal(result.installed, true);
    assert.equal(result.binary, "/usr/bin/true");
  } finally {
    cleanup();
  }
});

test("WELL_KNOWN_INSTALL_PATHS is frozen + non-empty + has ~/.codex/bin/codex", () => {
  assert.ok(Array.isArray(WELL_KNOWN_INSTALL_PATHS));
  assert.ok(WELL_KNOWN_INSTALL_PATHS.length > 0);
  assert.ok(Object.isFrozen(WELL_KNOWN_INSTALL_PATHS));
  assert.ok(WELL_KNOWN_INSTALL_PATHS.includes("~/.codex/bin/codex"));
});
