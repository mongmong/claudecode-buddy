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
  for (const entry of marketplace.plugins ?? []) {
    const pluginManifestPath = `plugins/${entry.name}/.claude-plugin/plugin.json`;
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
