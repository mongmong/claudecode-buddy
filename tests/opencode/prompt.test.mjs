import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt } from "../../plugins/opencode/scripts/lib/prompt.mjs";

test("buildReviewPrompt embeds the diff body verbatim", () => {
  const prompt = buildReviewPrompt({
    diff: "diff --git a/foo b/foo\n+bar",
    scope: "working-tree",
  });
  assert.match(prompt, /diff --git a\/foo b\/foo/);
  assert.match(prompt, /\+bar/);
});

test("buildReviewPrompt instructs the model to emit the JSON trailer", () => {
  const prompt = buildReviewPrompt({ diff: "x", scope: "branch", base: "main" });
  assert.match(prompt, /```json/);
  assert.match(prompt, /verdict/);
  assert.match(prompt, /blockers/);
});

test("buildReviewPrompt names the scope so the model knows what it is reviewing", () => {
  const wt = buildReviewPrompt({ diff: "x", scope: "working-tree" });
  const br = buildReviewPrompt({ diff: "x", scope: "branch", base: "main" });
  assert.match(wt, /working tree/i);
  assert.match(br, /branch.*main/i);
});

test("buildReviewPrompt rejects an empty diff with a clear error", () => {
  assert.throws(
    () => buildReviewPrompt({ diff: "", scope: "working-tree" }),
    /diff is empty/,
  );
});
