import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

test("models prints one provider/model per line, default first", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({
      model: "vendor-a/model-1",
      provider: {
        "vendor-a": { models: { "model-1": {}, "model-2": {} } },
        "vendor-b": { models: { "alpha": {} } },
      },
    }));
    const result = await runCompanion(["models"], { OPENCODE_CONFIG: cfgPath });
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines[0], "vendor-a/model-1");
    assert.deepEqual(lines.sort(), ["vendor-a/model-1", "vendor-a/model-2", "vendor-b/alpha"].sort());
  } finally {
    cleanup();
  }
});

test("models surfaces a clear error when config is missing", async () => {
  const result = await runCompanion(["models"], { OPENCODE_CONFIG: "/nonexistent/opencode.json" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not found/i);
});
