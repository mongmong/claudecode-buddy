// Version-coordination guard for the workspace marketplace manifest.
//
// The plugin version lives in TWO places that must stay in sync:
//   1. plugins/<name>/.claude-plugin/plugin.json:version (plugin's own manifest)
//   2. .claude-plugin/marketplace.json:plugins[*].version (marketplace listing)
//
// Both reviewers (Codex + opencode/deepseek-v4-pro) flagged the version-
// duplication coordination as a should-fix during plan-004 round-1 review;
// this test enforces synchronization so a future plugin version bump that
// updates only one file fails CI before shipping a stale marketplace listing.
//
// Per plan 004, see docs/architecture/decisions.md → D-012.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("marketplace.json plugins[].version matches each plugin's plugin.json version", () => {
  const marketplacePath = ".claude-plugin/marketplace.json";
  if (!existsSync(marketplacePath)) {
    // Plan 004 ships this file. Until it lands, the test is a no-op so the
    // suite stays green on branches that pre-date the marketplace.json.
    return;
  }
  const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
  // Per code-review feedback (codex round-1 + glm-5.1): assert plugins is a
  // non-empty array. A marketplace.json that publishes zero plugins is almost
  // certainly a bug — better to fail loud than silently no-op past the loop.
  assert.ok(
    Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0,
    `${marketplacePath} must declare a non-empty plugins[] array; got: ${JSON.stringify(marketplace.plugins)}`,
  );
  for (const entry of marketplace.plugins) {
    const pluginManifestPath = `plugins/${entry.name}/.claude-plugin/plugin.json`;
    // Per glm-5.1 review: surface a clear error when a marketplace entry
    // points at a plugin directory that doesn't exist (e.g., manifest stale
    // after a plugin removal). Default ENOENT message is opaque.
    assert.ok(
      existsSync(pluginManifestPath),
      `marketplace.json lists plugin "${entry.name}" but ${pluginManifestPath} does not exist. ` +
      `Either restore the plugin, or remove the entry from .claude-plugin/marketplace.json.`,
    );
    const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
    assert.equal(
      entry.version,
      pluginManifest.version,
      `marketplace.json plugins["${entry.name}"].version (${entry.version}) ` +
      `must match ${pluginManifestPath} version (${pluginManifest.version}). ` +
      `Bump both when releasing.`,
    );
  }
});
