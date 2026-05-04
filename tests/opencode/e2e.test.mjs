import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

const E2E_ENABLED = process.env.OPENCODE_E2E === "1";

test("e2e: real opencode review on a tiny diff produces a parseable verdict (no parse error)", { skip: !E2E_ENABLED }, async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "add.js"), "function add(a, b) { return a + b; }\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree"],
      { OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /verdict:\s+(approve|needs-attention)/);
    assert.doesNotMatch(result.stdout, /parse error/i,
      `model omitted the JSON trailer; full stdout: ${result.stdout}`);
    assert.match(result.stdout, /```json/);
  } finally {
    cleanup();
  }
});

test("e2e: real opencode prompt forwarding produces a parseable verdict", { skip: !E2E_ENABLED }, async () => {
  const promptText = `Review this tiny snippet and reply with Markdown findings followed by a fenced JSON trailer.

\`\`\`js
function add(a, b) { return a + b; }
\`\`\`

Trailer format (verbatim):

\`\`\`json
{"verdict": "approve" | "needs-attention", "blockers": []}
\`\`\``;
  const result = await runCompanion(["prompt", promptText], {});
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /verdict:\s+(approve|needs-attention)/);
  assert.doesNotMatch(result.stdout, /parse error/i,
    `model omitted the JSON trailer for the prompt route; full stdout: ${result.stdout}`);
});

test("e2e: setup against the real binary reports installed", { skip: !E2E_ENABLED }, async () => {
  const result = await runCompanion(["setup"], {});
  assert.equal(result.code, 0);
  assert.match(result.stdout, /opencode is installed/i);
});
