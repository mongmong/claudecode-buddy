#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("1.14.33-mock");
  process.exit(0);
}

if (args[0] === "session" && args[1] === "list" && args.includes("--format") && args.includes("json")) {
  if (process.env.OPENCODE_FIXTURE_SESSIONS && existsSync(process.env.OPENCODE_FIXTURE_SESSIONS)) {
    console.log(readFileSync(process.env.OPENCODE_FIXTURE_SESSIONS, "utf8"));
  } else {
    console.log(JSON.stringify([
      { id: "ses_mockSESSION12345", title: "Mock", updated: 1777854512914, directory: "/tmp/mock-cwd" },
    ]));
  }
  process.exit(0);
}

console.error("mock-opencode-session-list: unsupported invocation");
process.exit(2);
