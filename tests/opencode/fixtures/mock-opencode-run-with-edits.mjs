#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Handle --version specially so cli-detection treats us as installed AND we
// don't write fixed.js into the wrong directory (cli-detection invokes us
// without --dir).
if (process.argv.includes("--version")) {
  process.stdout.write("mock-opencode-run-with-edits 0.0.0\n");
  process.exit(0);
}

const dir = process.argv.find((a, i) => process.argv[i - 1] === "--dir") ?? process.cwd();
writeFileSync(join(dir, "fixed.js"), "// fixed by mock opencode\nfunction add(a, b) { return a + b; }\n");

const SESSION = "ses_mock_run_edits";
const MSG = "msg_mock_run_edits";
const events = [
  { type: "step_start", sessionID: SESSION, part: { type: "step-start", messageID: MSG } },
  {
    type: "text",
    sessionID: SESSION,
    part: {
      type: "text",
      messageID: MSG,
      sessionID: SESSION,
      text: "Created `fixed.js` with the corrected `add` function.",
    },
  },
  { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", messageID: MSG } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(0);
