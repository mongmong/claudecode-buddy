#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("mock-opencode-run-success 0.0.0\n");
  process.exit(0);
}
const SESSION = "ses_mock_run_ok";
const MSG = "msg_mock_run_ok";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  {
    type: "text",
    sessionID: SESSION,
    part: {
      type: "text",
      messageID: MSG,
      sessionID: SESSION,
      text: "Done. No code changes were necessary — the bug was a false alarm.",
    },
  },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
