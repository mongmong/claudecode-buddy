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
