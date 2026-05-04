import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeOpencode } from "../../plugins/opencode/scripts/lib/invoke.mjs";
import { resolve } from "node:path";

const SUCCESS_BIN = resolve("tests/opencode/fixtures/mock-opencode-success.mjs");
const MALFORMED_BIN = resolve("tests/opencode/fixtures/mock-opencode-malformed.mjs");
const MULTIPART_BIN = resolve("tests/opencode/fixtures/mock-opencode-multipart.mjs");
const SLEEP_BIN = resolve("tests/opencode/fixtures/mock-opencode-sleep.mjs");
const STUBBORN_SLEEP_BIN = resolve("tests/opencode/fixtures/mock-opencode-stubborn-sleep.mjs");
const MULTI_MSG_BIN = resolve("tests/opencode/fixtures/mock-opencode-multi-message.mjs");

test("invokeOpencode returns the assistant text reconstructed from text-typed events", async () => {
  const result = await invokeOpencode({
    binary: SUCCESS_BIN,
    prompt: "ignored by mock",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Looks fine/);
  assert.match(result.text, /verdict/);
});

test("invokeOpencode concatenates multiple text parts for the same messageID in order", async () => {
  const result = await invokeOpencode({
    binary: MULTIPART_BIN,
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Part one\./);
  assert.match(result.text, /Part two\./);
  assert.match(result.text, /verdict/);
  assert.ok(result.text.indexOf("Part one") < result.text.indexOf("Part two"));
});

test("invokeOpencode passes through malformed (no-trailer) text — parsing happens later", async () => {
  const result = await invokeOpencode({
    binary: MALFORMED_BIN,
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /I refuse to add a JSON trailer/);
});

test("invokeOpencode reports a non-zero exit as failure", async () => {
  const result = await invokeOpencode({
    binary: "/usr/bin/false",
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /exit/i);
});

test("invokeOpencode reports missing binary as failure", async () => {
  const result = await invokeOpencode({
    binary: "/nonexistent/opencode",
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, false);
});

test("invokeOpencode aborts a SIGTERM-respecting process when timeoutMs is exceeded", async () => {
  const start = Date.now();
  const result = await invokeOpencode({
    binary: SLEEP_BIN,
    prompt: "x",
    cwd: process.cwd(),
    timeoutMs: 500,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
  assert.ok(elapsed < 3000, `SIGTERM-respecting timeout took ${elapsed} ms, expected < 3000`);
});

test("invokeOpencode escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const start = Date.now();
  const result = await invokeOpencode({
    binary: STUBBORN_SLEEP_BIN,
    prompt: "x",
    cwd: process.cwd(),
    timeoutMs: 500,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
  // SIGTERM ignored; SIGKILL escalation grace is 2000 ms in the implementation.
  // timeoutMs(500) + killGraceMs(2000) + scheduling slack(~500) = ~3000 ms ceiling.
  assert.ok(elapsed < 3500, `SIGKILL escalation took ${elapsed} ms, expected < 3500`);
});

test("invokeOpencode picks the message whose last text event arrived latest (multi-messageID)", async () => {
  const result = await invokeOpencode({
    binary: MULTI_MSG_BIN,
    prompt: "x",
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /A first\./);
  assert.match(result.text, /A FINISHES LAST\./);
  assert.doesNotMatch(result.text, /B middle\./,
    `expected msg_A to win; got: ${result.text}`);
});
