import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectOpencode, WELL_KNOWN_INSTALL_PATHS } from "../../plugins/opencode/scripts/lib/cli-detection.mjs";

// A minimal executable that prints a version on `--version`. Used in
// well-known-path-scan tests where we drop a fake "opencode" into a fake
// HOME's known install location to exercise the scan logic.
//
// Shebang is hardcoded to /bin/sh because the scan tests pass
// PATH="/nonexistent" to force the scan path; a #!/usr/bin/env shebang
// would fail to resolve `env` itself and the fake binary wouldn't run.
const FAKE_OPENCODE = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fake-opencode 0.0.0"
  exit 0
fi
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
  const fullPath = relPath.startsWith("~/")
    ? join(home, relPath.slice(2))
    : relPath;
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, FAKE_OPENCODE);
  chmodSync(fullPath, 0o755);
  return fullPath;
}

test("detectOpencode reports a present binary by version", () => {
  const result = detectOpencode({ env: { OPENCODE_BIN: "/usr/bin/true", PATH: process.env.PATH } });
  assert.equal(result.installed, true);
});

test("detectOpencode reports missing when binary is not on PATH and no fallback exists", () => {
  const result = detectOpencode({
    env: { OPENCODE_BIN: "/nonexistent/opencode", PATH: "/nonexistent" },
  });
  assert.equal(result.installed, false);
  assert.match(result.guidance, /install/i);
});

test("detectOpencode reports broken when binary exists but --version exits non-zero", () => {
  // /usr/bin/false exists but exits with code 1, so --version "fails".
  const result = detectOpencode({
    env: { OPENCODE_BIN: "/usr/bin/false", PATH: process.env.PATH },
  });
  assert.equal(result.installed, false);
  assert.equal(result.broken, true);
  assert.match(result.guidance, /install/i);
});

test("detectOpencode falls back to ~/.opencode/bin/opencode when not on PATH", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    const fakeBin = dropFakeBinary(home, "~/.opencode/bin/opencode");
    // Empty PATH so PATH lookup definitely misses; HOME points at our fake.
    const result = detectOpencode({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, true, `guidance: ${result.guidance}`);
    assert.equal(result.binary, fakeBin);
    assert.match(result.version, /fake-opencode/);
  } finally {
    cleanup();
  }
});

test("detectOpencode falls back to ~/.local/bin/opencode when ~/.opencode is absent", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    const fakeBin = dropFakeBinary(home, "~/.local/bin/opencode");
    const result = detectOpencode({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, true);
    assert.equal(result.binary, fakeBin);
  } finally {
    cleanup();
  }
});

test("detectOpencode well-known scan honors documented order (~/.opencode wins over ~/.local)", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    const opencodePath = dropFakeBinary(home, "~/.opencode/bin/opencode");
    const localPath = dropFakeBinary(home, "~/.local/bin/opencode");
    assert.notEqual(opencodePath, localPath, "test sanity — paths should differ");
    const result = detectOpencode({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, true);
    assert.equal(
      result.binary,
      opencodePath,
      "expected ~/.opencode/bin/opencode to win — it appears first in WELL_KNOWN_INSTALL_PATHS",
    );
  } finally {
    cleanup();
  }
});

test("detectOpencode scan ignores non-executable files at well-known paths", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    const path = join(home, ".opencode/bin/opencode");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not executable\n"); // mode 0o644 — readable, not executable
    chmodSync(path, 0o644);
    const result = detectOpencode({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, false, "non-executable file at well-known path must not satisfy the scan");
  } finally {
    cleanup();
  }
});

test("detectOpencode scan ignores directories named 'opencode' at well-known paths", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    // Drop a directory (not a file) at the well-known path. The scan must
    // not return it — only regular executable files count.
    mkdirSync(join(home, ".opencode/bin/opencode"), { recursive: true });
    const result = detectOpencode({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, false);
  } finally {
    cleanup();
  }
});

test("OPENCODE_BIN takes precedence over the well-known scan", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    // Drop a fake at the scan path that would normally win...
    dropFakeBinary(home, "~/.opencode/bin/opencode");
    // ...but explicitly pin OPENCODE_BIN to /usr/bin/true. /usr/bin/true
    // exits 0 on any args (including --version), so it's a stand-in for
    // a "user-pinned binary" that resolveBinary must prefer.
    const result = detectOpencode({
      env: { OPENCODE_BIN: "/usr/bin/true", PATH: "/nonexistent", HOME: home },
    });
    assert.equal(result.installed, true);
    assert.equal(result.binary, "/usr/bin/true", "OPENCODE_BIN must win over the scan fallback");
  } finally {
    cleanup();
  }
});

test("PATH lookup takes precedence over the well-known scan", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    dropFakeBinary(home, "~/.opencode/bin/opencode");
    // Use the host PATH — the real `opencode` binary on this machine should
    // be found via PATH before the scan ever runs. Skip if no real opencode
    // is installed in this environment.
    let realOpencode = false;
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync("opencode", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      realOpencode = true;
    } catch {}
    if (!realOpencode) return;
    const result = detectOpencode({ env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(result.installed, true);
    assert.equal(result.binary, "opencode", "PATH lookup returns the bare 'opencode' name; scan would return an absolute path");
  } finally {
    cleanup();
  }
});

test("guidance text lists the well-known scan locations when nothing is found", () => {
  const { home, cleanup } = makeFakeHome();
  try {
    const result = detectOpencode({ env: { PATH: "/nonexistent", HOME: home } });
    assert.equal(result.installed, false);
    // At least one of the documented scan paths should appear verbatim
    // (HOME-expanded) in the guidance, plus the OPENCODE_BIN escape hatch.
    assert.match(result.guidance, /opencode\/bin\/opencode/);
    assert.match(result.guidance, /OPENCODE_BIN/);
    assert.match(result.guidance, /opencode\.ai\/install/);
  } finally {
    cleanup();
  }
});

test("WELL_KNOWN_INSTALL_PATHS export is frozen + non-empty", () => {
  assert.ok(Array.isArray(WELL_KNOWN_INSTALL_PATHS));
  assert.ok(WELL_KNOWN_INSTALL_PATHS.length > 0);
  assert.ok(Object.isFrozen(WELL_KNOWN_INSTALL_PATHS));
  // ~/.opencode is the official installer location — must be in the list.
  assert.ok(
    WELL_KNOWN_INSTALL_PATHS.some((p) => p === "~/.opencode/bin/opencode"),
    "~/.opencode/bin/opencode (the official installer path) must be in the scan list",
  );
});
