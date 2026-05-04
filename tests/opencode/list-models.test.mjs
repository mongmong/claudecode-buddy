import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempRepo } from "./helpers.mjs";
import { listModels } from "../../plugins/opencode/scripts/lib/list-models.mjs";

test("listModels returns a flat list of provider/model strings from a real-shaped config", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({
      model: "vendor-a/model-1",
      provider: {
        "vendor-a": {
          name: "Vendor A",
          models: { "model-1": { name: "Model 1" }, "model-2": { name: "Model 2" } },
        },
        "vendor-b": {
          name: "Vendor B",
          models: { "alpha": {}, "beta": {} },
        },
      },
    }));
    const result = listModels({ configPath: cfgPath });
    assert.equal(result.ok, true);
    assert.equal(result.value[0], "vendor-a/model-1");
    assert.deepEqual(
      result.value.sort(),
      ["vendor-a/model-1", "vendor-a/model-2", "vendor-b/alpha", "vendor-b/beta"].sort(),
    );
  } finally {
    cleanup();
  }
});

test("listModels surfaces a clear error when the config is missing", () => {
  const result = listModels({ configPath: "/nonexistent/opencode.json" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("listModels surfaces a clear error when no provider has models", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({ model: "x/y", provider: {} }));
    const result = listModels({ configPath: cfgPath });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, ["x/y"]);
  } finally {
    cleanup();
  }
});

test("listModels handles a config with default model but no provider section", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({ model: "anthropic/claude-sonnet-4-6" }));
    const result = listModels({ configPath: cfgPath });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, ["anthropic/claude-sonnet-4-6"]);
  } finally {
    cleanup();
  }
});

test("listModels surfaces a clear error when there are no models at all", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({}));
    const result = listModels({ configPath: cfgPath });
    assert.equal(result.ok, false);
    assert.match(result.error, /no models/i);
  } finally {
    cleanup();
  }
});
