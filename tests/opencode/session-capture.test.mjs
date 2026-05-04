import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  captureSessionIdFromStderr,
  captureLatestSessionForCwd,
  verifySessionExists,
} from "../../plugins/opencode/scripts/lib/session-capture.mjs";
import { makeTempRepo } from "./helpers.mjs";

const LIST_BIN = resolve("tests/opencode/fixtures/mock-opencode-session-list.mjs");

// --- captureSessionIdFromStderr ---

test("captureSessionIdFromStderr: extracts ses_ id from real opencode log line", () => {
  const stderr = `
INFO  2026-05-04T00:28:32 +5ms service=session id=ses_20f9d00edffejjPulI1sCyTQ99 slug=misty-meadow version=1.14.33 projectID=20a0b376e511ff347670153897dc003fcdede60b created
INFO  2026-05-04T00:28:32 +0ms service=server method=POST path=/session/ses_20f9d00edffejjPulI1sCyTQ99/message request
`;
  assert.equal(captureSessionIdFromStderr(stderr), "ses_20f9d00edffejjPulI1sCyTQ99");
});

test("captureSessionIdFromStderr: returns null on empty input", () => {
  assert.equal(captureSessionIdFromStderr(""), null);
  assert.equal(captureSessionIdFromStderr(null), null);
  assert.equal(captureSessionIdFromStderr(undefined), null);
});

test("captureSessionIdFromStderr: returns null when no service=session line present", () => {
  assert.equal(
    captureSessionIdFromStderr("INFO 2026 service=server status=200\nERROR something else"),
    null,
  );
});

test("captureSessionIdFromStderr: returns FIRST session-id when multiple appear", () => {
  const stderr = `
INFO 2026 service=session id=ses_first slug=a created
INFO 2026 service=session id=ses_second slug=b updated
`;
  assert.equal(captureSessionIdFromStderr(stderr), "ses_first");
});

test("captureSessionIdFromStderr: tolerates extra whitespace + log-level variations", () => {
  const stderr = "DEBUG   2026-05-04   service=session    id=ses_xyz123ABC   slug=foo";
  assert.equal(captureSessionIdFromStderr(stderr), "ses_xyz123ABC");
});

// --- verifySessionExists ---

test("verifySessionExists: true when the id is in session list", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const sessionsFile = join(dir, "sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_LIVEaaa", updated: 1, directory: "/tmp" },
      { id: "ses_LIVEbbb", updated: 2, directory: "/tmp" },
    ]));
    process.env.OPENCODE_FIXTURE_SESSIONS = sessionsFile;
    try {
      const r = verifySessionExists(LIST_BIN, "ses_LIVEbbb");
      assert.equal(r.ok, true);
      assert.equal(r.exists, true);
    } finally { delete process.env.OPENCODE_FIXTURE_SESSIONS; }
  } finally { cleanup(); }
});

test("verifySessionExists: false when the id is not in session list", () => {
  const r = verifySessionExists(LIST_BIN, "ses_GHOSTED");
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
});

test("verifySessionExists: false for malformed id (defense)", () => {
  const r = verifySessionExists(LIST_BIN, "not-a-session");
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
});

test("verifySessionExists: ok:false when binary missing", () => {
  const r = verifySessionExists("/nonexistent/binary", "ses_x");
  assert.equal(r.ok, false);
  assert.match(r.error, /session list failed/i);
});

// --- captureLatestSessionForCwd ---

test("captureLatestSessionForCwd: picks highest updated where directory matches cwd", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const sessionsFile = join(dir, "sessions.json");
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "ses_OLDER", updated: 100, directory: "/tmp/cwd-A" },
      { id: "ses_NEWER", updated: 200, directory: "/tmp/cwd-A" },
      { id: "ses_OTHER", updated: 300, directory: "/tmp/cwd-B" },
    ]));
    process.env.OPENCODE_FIXTURE_SESSIONS = sessionsFile;
    try {
      const r = captureLatestSessionForCwd(LIST_BIN, "/tmp/cwd-A");
      assert.equal(r.ok, true);
      assert.equal(r.value, "ses_NEWER",
        "must pick the highest updated WITHIN the matching cwd, ignoring sessions in other directories");
    } finally { delete process.env.OPENCODE_FIXTURE_SESSIONS; }
  } finally { cleanup(); }
});

test("captureLatestSessionForCwd: returns null when no sessions match cwd", () => {
  const r = captureLatestSessionForCwd(LIST_BIN, "/tmp/no-match");
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});
