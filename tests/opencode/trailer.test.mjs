import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTrailer } from "../../plugins/opencode/scripts/lib/trailer.mjs";

test("extractTrailer parses a valid fenced JSON trailer", () => {
  const text = `## Findings\n\n1. Bug in foo.ts\n\n\`\`\`json\n{"verdict":"needs-attention","blockers":["Bug in foo.ts"]}\n\`\`\`\n`;
  const result = extractTrailer(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    verdict: "needs-attention",
    blockers: ["Bug in foo.ts"],
  });
});

test("extractTrailer parses approve verdict with empty blockers", () => {
  const text = "All good.\n\n```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```";
  const result = extractTrailer(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, "approve");
  assert.deepEqual(result.value.blockers, []);
});

test("extractTrailer fails when no JSON block is present", () => {
  const result = extractTrailer("Just prose, no JSON.");
  assert.equal(result.ok, false);
  assert.match(result.error, /no fenced JSON trailer/i);
});

test("extractTrailer fails when JSON is malformed", () => {
  const text = "```json\n{not valid}\n```";
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /parse/i);
});

test("extractTrailer fails when verdict is missing", () => {
  const text = '```json\n{"blockers":[]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /verdict/i);
});

test("extractTrailer fails when verdict is not in the enum", () => {
  const text = '```json\n{"verdict":"maybe","blockers":[]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /verdict/i);
});

test("extractTrailer fails when blockers is not an array of strings", () => {
  const text = '```json\n{"verdict":"approve","blockers":[1,2]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /blockers/i);
});

test("extractTrailer fails when blockers contains an empty string", () => {
  const text = '```json\n{"verdict":"approve","blockers":[""]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /non-empty/i);
});

test("extractTrailer fails when there is an unexpected additional property", () => {
  const text = '```json\n{"verdict":"approve","blockers":[],"extra":"nope"}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, false);
  assert.match(result.error, /additional|unexpected/i);
});

test("extractTrailer picks the LAST JSON block when there are multiple", () => {
  const text = '```json\n{"verdict":"approve","blockers":[]}\n```\n\nmore prose\n\n```json\n{"verdict":"needs-attention","blockers":["x"]}\n```';
  const result = extractTrailer(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.verdict, "needs-attention");
});
