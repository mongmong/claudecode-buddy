#!/usr/bin/env node
// Records process.argv (the full opencode invocation) to the file at
// $OPENCODE_RECORD_ARGS_PATH so tests can assert what flags were forwarded,
// then emits a canned success NDJSON event stream so the companion treats the
// invocation as successful.
import { appendFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("mock-opencode-record-args 0.0.0\n");
  process.exit(0);
}

const recordPath = process.env.OPENCODE_RECORD_ARGS_PATH;
if (recordPath) {
  appendFileSync(recordPath, JSON.stringify(process.argv.slice(2)) + "\n");
}

const SESSION = "ses_mock_record";
const MSG = "msg_mock_record";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  {
    type: "text",
    sessionID: SESSION,
    part: {
      type: "text",
      messageID: MSG,
      sessionID: SESSION,
      text: "## Findings\n\nrecorded.\n\n```json\n{\"verdict\":\"approve\",\"blockers\":[]}\n```\n",
    },
  },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
