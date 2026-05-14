// Plan-007 Phase 2 tests for lib/invoke.mjs — codex-specific event parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvents, captureThreadId, invokeCodexRaw } from "../../plugins/codex/scripts/lib/invoke.mjs";
import { resolve } from "node:path";

test("parseEvents extracts assistant text from item.completed/agent_message events (Phase 1.5 gate 1 shape)", () => {
  const stdout = [
    `{"type":"thread.started","thread_id":"019e1fee-3cd2-7dd0-a28f-5d10fb3f3f99"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}`,
    `{"type":"turn.completed","usage":{}}`,
  ].join("\n");
  const messages = parseEvents(stdout);
  assert.deepEqual(messages, ["hello"]);
});

test("parseEvents concatenates multiple agent_message events in order (streaming case)", () => {
  // Codex can emit multiple agent_message events in a single turn when the
  // model streams thinking blocks alongside text. Our parser collects them
  // all and the caller concatenates.
  const stdout = [
    `{"type":"thread.started","thread_id":"abc"}`,
    `{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"part 1\\n"}}`,
    `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"part 2\\n"}}`,
    `{"type":"turn.completed","usage":{}}`,
  ].join("\n");
  assert.deepEqual(parseEvents(stdout), ["part 1\n", "part 2\n"]);
});

test("parseEvents skips non-agent_message item.completed events (file_change, etc.)", () => {
  const stdout = [
    `{"type":"item.completed","item":{"id":"i0","type":"file_change","changes":[]}}`,
    `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"only this"}}`,
    `{"type":"item.completed","item":{"id":"i2","type":"command_execution","cmd":"ls"}}`,
  ].join("\n");
  assert.deepEqual(parseEvents(stdout), ["only this"]);
});

test("parseEvents tolerates non-JSON lines (e.g., log output mixed in)", () => {
  const stdout = [
    `Some log line that isn't JSON`,
    `{"type":"thread.started","thread_id":"abc"}`,
    `Another log line`,
    `{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"resilient"}}`,
  ].join("\n");
  assert.deepEqual(parseEvents(stdout), ["resilient"]);
});

test("captureThreadId extracts UUID from first-line thread.started event (Phase 1.5 gate 2)", () => {
  const stdout = `{"type":"thread.started","thread_id":"019e1fee-3cd2-7dd0-a28f-5d10fb3f3f99"}\n{"type":"turn.started"}`;
  assert.equal(captureThreadId(stdout), "019e1fee-3cd2-7dd0-a28f-5d10fb3f3f99");
});

test("captureThreadId returns null if thread.started not present", () => {
  const stdout = `{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"x"}}`;
  assert.equal(captureThreadId(stdout), null);
});

test("captureThreadId short-circuits after the first non-thread.started event (it's always first when present)", () => {
  // Defensive: if thread.started doesn't appear on line 1 but later in the
  // stream, our parser correctly stops scanning. This documents the contract
  // verified in Phase 1.5 gate 2 (thread.started is always emitted first).
  const stdout = `{"type":"turn.started"}\n{"type":"thread.started","thread_id":"abc"}`;
  assert.equal(captureThreadId(stdout), null);
});

test("invokeCodexRaw parses mock-codex-success fixture cleanly", async () => {
  const SUCCESS_BIN = resolve("tests/codex/fixtures/mock-codex-success.mjs");
  const result = await invokeCodexRaw({
    binary: SUCCESS_BIN,
    args: ["exec", "--json", "anything"],
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Looks fine/);
  assert.match(result.text, /verdict.*approve/);
  assert.equal(result.threadId, "019e1fee-3cd2-7dd0-a28f-5d10fb3f3f99");
  assert.equal(result.exit_code, 0);
});
