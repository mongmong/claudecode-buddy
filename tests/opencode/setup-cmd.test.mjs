import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompanion, makeTempRepo, writeFixture } from "./helpers.mjs";

test("setup reports OK when binary and config are both present", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    writeFixture(dir, "opencode.json", JSON.stringify({ model: "vendor/model-a" }));
    const result = await runCompanion(["setup"], {
      OPENCODE_BIN: "/usr/bin/true",
      OPENCODE_CONFIG: `${dir}/opencode.json`,
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /opencode is installed/i);
    assert.match(result.stdout, /vendor\/model-a/);
  } finally {
    cleanup();
  }
});

test("setup reports missing binary with install guidance", async () => {
  const result = await runCompanion(["setup"], {
    OPENCODE_BIN: "/nonexistent/opencode",
    PATH: "/nonexistent",
    OPENCODE_CONFIG: "/nonexistent/opencode.json",
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not installed/i);
  assert.match(result.stdout, /install/i);
});

test("setup reports missing config when binary is present but config is not", async () => {
  const result = await runCompanion(["setup"], {
    OPENCODE_BIN: "/usr/bin/true",
    OPENCODE_CONFIG: "/nonexistent/opencode.json",
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /opencode is installed/i);
  assert.match(result.stdout, /config not found/i);
});
