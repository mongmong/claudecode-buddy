// Plan-007 Phase 8: cross-plugin byte-equality test.
//
// The opencode and codex plugins share CLI-agnostic helper modules. Per
// plan-007 code-sharing Strategy C (copy + diverge + cross-sync test), the
// shared files must stay byte-identical across the two plugins so a bug
// fix in one propagates correctly when manually synced to the other.
//
// Per round-1 R1 (Codex + GLM + DeepSeek-Pro + Self-Opus all flagged),
// only 3 lib files are truly byte-identical:
//   - lib/fd-bound.mjs   (pure POSIX fd wrapper)
//   - lib/pid-identity.mjs (CLI-agnostic; "buddy-supervisor" prefix shared)
//   - lib/args.mjs (pure shell-style splitter)
//
// The other lib files (jobs, sessions, trailer, scope, supervisor, etc.)
// are structural twins but contain plugin-specific paths or error strings
// and are NOT asserted byte-identical here.
//
// Additionally, agents/codex-rescue.md is asserted byte-identical to
// agents/codex-review.md EXCEPT for the `name:` frontmatter field (per
// plan-007 R6 alias mechanism).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BYTE_IDENTICAL_LIB_FILES = [
  "scripts/lib/fd-bound.mjs",
  "scripts/lib/pid-identity.mjs",
  "scripts/lib/args.mjs",
];

for (const rel of BYTE_IDENTICAL_LIB_FILES) {
  test(`${rel} is byte-identical between opencode and codex plugins`, () => {
    const opencodePath = resolve("plugins/opencode", rel);
    const codexPath = resolve("plugins/codex", rel);
    if (!existsSync(opencodePath)) return; // opencode plugin removed; skip
    if (!existsSync(codexPath)) return; // codex plugin removed; skip
    const opencode = readFileSync(opencodePath);
    const codex = readFileSync(codexPath);
    assert.deepEqual(
      opencode,
      codex,
      `Drift detected — ${rel} differs between plugins/opencode/ and plugins/codex/. ` +
      `When updating a byte-identical shared file in one plugin, hand-port the same ` +
      `change to the other.`,
    );
  });
}

test("agents/codex-rescue.md is byte-identical to agents/codex-review.md except for the name: frontmatter field", () => {
  const reviewPath = resolve("plugins/codex/agents/codex-review.md");
  const rescuePath = resolve("plugins/codex/agents/codex-rescue.md");
  if (!existsSync(reviewPath) || !existsSync(rescuePath)) return; // plugin not installed
  const review = readFileSync(reviewPath, "utf8");
  const rescue = readFileSync(rescuePath, "utf8");
  // Replace `name: codex-rescue` with `name: codex-review` in the rescue file
  // and assert the result equals the review file. Per plan-007 R6, this is
  // the literal-copy alias mechanism.
  const normalizedRescue = rescue.replace(/^name: codex-rescue$/m, "name: codex-review");
  assert.equal(
    normalizedRescue,
    review,
    "Drift detected — codex-rescue.md and codex-review.md differ beyond the name: field. " +
    "Per plan-007 R6, codex-rescue.md must be a literal copy of codex-review.md with " +
    "only the file-level `name:` field changed.",
  );
});
