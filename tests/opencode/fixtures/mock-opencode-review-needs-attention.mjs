#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("1.14.33-mock");
  process.exit(0);
}

if (process.env.OPENCODE_FIXTURE_LOG) {
  writeFileSync(process.env.OPENCODE_FIXTURE_LOG, JSON.stringify({ argv: args }) + "\n", { flag: "a" });
}

if (args[0] === "session" && args[1] === "list") {
  // Minimal session list response so verifySessionExists doesn't blow up.
  console.log("[]");
  process.exit(0);
}

// Emit session-created stderr line + an NDJSON text event with a needs-attention trailer.
const sessionFlagIdx = args.indexOf("--session");
const sessionId = sessionFlagIdx >= 0 ? args[sessionFlagIdx + 1] : "ses_mockNEEDSatt";
process.stderr.write(`INFO ${new Date().toISOString()} +5ms service=session id=${sessionId} slug=mock created\n`);

const reviewBody = `Found a problem.

\`\`\`json
{"verdict": "needs-attention", "blockers": ["foo bug", "bar bug"]}
\`\`\`
`;

console.log(JSON.stringify({
  type: "text",
  part: { type: "text", messageID: "msg_001", text: reviewBody },
}));

process.exit(0);
