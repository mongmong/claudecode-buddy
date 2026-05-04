import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOpencode } from "../../plugins/opencode/scripts/lib/cli-detection.mjs";

test("detectOpencode reports a present binary by version", () => {
  const result = detectOpencode({ env: { OPENCODE_BIN: "/usr/bin/true", PATH: process.env.PATH } });
  assert.equal(result.installed, true);
});

test("detectOpencode reports missing when binary is not on PATH", () => {
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
