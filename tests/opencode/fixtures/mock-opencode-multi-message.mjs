#!/usr/bin/env node
// Two messageIDs interleaved. msg_A first appears, then msg_B appears, then msg_A
// gets one more text part. The "final" message — by last-update-index — is msg_A.
const SESSION = "ses_mock_multi_msg";
const A = "msg_A";
const B = "msg_B";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: A } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: A, sessionID: SESSION, text: "A first.\n" } },
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: B } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: B, sessionID: SESSION, text: "B middle.\n" } },
  { type: "text", sessionID: SESSION, part: { type: "text", messageID: A, sessionID: SESSION, text: "A FINISHES LAST." } },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: A } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
