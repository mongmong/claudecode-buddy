#!/usr/bin/env node
// Handle --version specially so cli-detection treats us as installed.
if (process.argv.includes("--version")) {
  process.stdout.write("mock-opencode-run-fail 0.0.0\n");
  process.exit(0);
}
const SESSION = "ses_mock_run_fail";
const MSG = "msg_mock_run_fail";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  {
    type: "text",
    sessionID: SESSION,
    part: {
      type: "text",
      messageID: MSG,
      sessionID: SESSION,
      text: "I tried but I am going to fail.",
    },
  },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(7);
