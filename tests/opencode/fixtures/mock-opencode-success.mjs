#!/usr/bin/env node
// Pretends to be `opencode run --format json ...`. Emits canned NDJSON events
// in the same shape as the real opencode CLI (verified 2026-05-03).
const SESSION = "ses_mock_success";
const MSG = "msg_mock_success";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  {
    type: "text",
    sessionID: SESSION,
    part: {
      type: "text",
      messageID: MSG,
      sessionID: SESSION,
      text: "## Findings\n\n1. Looks fine.\n\n```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```\n",
    },
  },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
