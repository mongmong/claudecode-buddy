#!/usr/bin/env node
// Pretends to be `codex exec --json ...`. Emits NDJSON events matching the
// shape verified in plan-007 Phase 1.5 gate 1.
if (process.argv.includes("--version")) {
  process.stdout.write("mock-codex-success 0.0.0\n");
  process.exit(0);
}
const THREAD = "019e1fee-3cd2-7dd0-a28f-5d10fb3f3f99";
const events = [
  { type: "thread.started", thread_id: THREAD },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: {
      id: "item_0",
      type: "agent_message",
      text: "## Findings\n\n1. Looks fine.\n\n```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```\n",
    },
  },
  { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
