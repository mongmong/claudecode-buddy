#!/usr/bin/env node
const SESSION = "ses_mock_multi";
const MSG = "msg_mock_multi";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: MSG, sessionID: SESSION, text: "Part one.\n" } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: MSG, sessionID: SESSION, text: "Part two.\n" } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: MSG, sessionID: SESSION, text: "```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```" } },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
