import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import { dispatchOpencode } from "../../plugins/opencode/scripts/lib/review-dispatch.mjs";
import {
  loadSessionId,
  saveSessionId,
  acquireSessionLock,
} from "../../plugins/opencode/scripts/lib/sessions.mjs";
import { makeTempRepo } from "./helpers.mjs";

const MOCK_SESSION_BIN = resolve("tests/opencode/fixtures/mock-opencode-session-list.mjs");

function fakeInvoke(behavior) {
  return async ({ args }) => {
    const sessionFlagIdx = args.indexOf("--session");
    behavior._observedArgs = [...args];
    behavior._observedSessionId = sessionFlagIdx >= 0 ? args[sessionFlagIdx + 1] : null;
    return behavior;
  };
}

function withMockSessions(dir, sessions, fn) {
  const path = join(dir, `mock-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(sessions));
  process.env.OPENCODE_FIXTURE_SESSIONS = path;
  try {
    return fn();
  } finally {
    delete process.env.OPENCODE_FIXTURE_SESSIONS;
  }
}

test("dispatchOpencode: first call (no existing session) → no --session flag, captures + saves new id", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const fake = {
      ok: true,
      text: "review body",
      stderr: "INFO 2026 service=session id=ses_NEW12345 slug=foo created\n",
    };
    await withMockSessions(dir, [
      { id: "ses_NEW12345", updated: 100, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "hi",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(result.sessionId, "ses_NEW12345");
      assert.equal(fake._observedSessionId, null, "no --session flag on first call");
    });
    const saved = loadSessionId(dir, "scratch", "review", "vendor/m");
    assert.equal(saved.value, "ses_NEW12345");
  } finally { cleanup(); }
});

test("dispatchOpencode: second call with stored alive session → pre-flight passes, --session flag added", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_PRIOR99");
    const fake = {
      ok: true,
      text: "review body 2",
      stderr: "INFO 2026 service=session id=ses_PRIOR99 slug=foo updated\n",
    };
    await withMockSessions(dir, [
      { id: "ses_PRIOR99", updated: 200, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "again",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(fake._observedSessionId, "ses_PRIOR99");
      assert.equal(result.sessionId, "ses_PRIOR99");
    });
  } finally { cleanup(); }
});

test("dispatchOpencode: stored id NOT in session list → pre-flight deletes file + runs fresh", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_STALEpre");
    const fake = {
      ok: true,
      text: "fresh body",
      stderr: "INFO 2026 service=session id=ses_NEWpre slug=foo created\n",
    };
    await withMockSessions(dir, [
      { id: "ses_NEWpre", updated: 300, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "hi",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(fake._observedSessionId, null,
        "pre-flight should have detected stale id and dropped --session from argv");
      assert.equal(result.sessionId, "ses_NEWpre");
    });
    assert.equal(loadSessionId(dir, "scratch", "review", "vendor/m").value, "ses_NEWpre",
      "stale file replaced with the freshly-created session id");
  } finally { cleanup(); }
});

test("dispatchOpencode: reset:true deletes the stored session-id before dispatch", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_OLDONE");
    const fake = {
      ok: true,
      text: "fresh body",
      stderr: "INFO 2026 service=session id=ses_NEWONE slug=foo created\n",
    };
    await withMockSessions(dir, [
      { id: "ses_NEWONE", updated: 300, directory: dir },
    ], async () => {
      await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "fresh",
        opencodeArgs: ["run", "--format", "default"],
        reset: true,
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(fake._observedSessionId, null, "reset must drop --session flag from argv");
    });
    assert.equal(loadSessionId(dir, "scratch", "review", "vendor/m").value, "ses_NEWONE");
  } finally { cleanup(); }
});

test("dispatchOpencode: noSession:true preserves the original stored id (no overwrite)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_KEEP");
    const fake = {
      ok: true,
      text: "ad-hoc body",
      stderr: "INFO 2026 service=session id=ses_TRANSIENT slug=foo created\n",
    };
    await withMockSessions(dir, [
      { id: "ses_KEEP", updated: 100, directory: dir },
      { id: "ses_TRANSIENT", updated: 200, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "ad-hoc",
        opencodeArgs: ["run", "--format", "default"],
        noSession: true,
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(fake._observedSessionId, null, "noSession must skip --session flag");
      assert.equal(result.sessionId, null,
        "noSession must NOT report the transient sessionId");
    });
    const saved = loadSessionId(dir, "scratch", "review", "vendor/m");
    assert.equal(saved.value, "ses_KEEP",
      "noSession must NOT overwrite the stored id with the transient session");
  } finally { cleanup(); }
});

test("dispatchOpencode: race deletion (alive at pre-flight, gone at run) → stderr backup detection + retry", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_RACE");
    let calls = 0;
    const invokeImpl = async ({ args }) => {
      calls += 1;
      const usingSession = args.includes("--session");
      if (calls === 1 && usingSession) {
        return {
          ok: true,
          text: "",
          stderr: "ERROR 2026 something went wrong\nmessage: \"Session not found: ses_RACE\"\n",
        };
      }
      return {
        ok: true,
        text: "post-recovery body",
        stderr: "INFO 2026 service=session id=ses_REBORN slug=foo created\n",
      };
    };
    await withMockSessions(dir, [
      { id: "ses_RACE", updated: 100, directory: dir },
      { id: "ses_REBORN", updated: 300, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "retry",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl,
      });
      assert.equal(result.ok, true);
      assert.equal(calls, 2, "should have retried once after stderr stale-session backup detection");
      assert.equal(loadSessionId(dir, "scratch", "review", "vendor/m").value, "ses_REBORN");
    });
  } finally { cleanup(); }
});

test("dispatchOpencode: lock contention → degraded mode (no --session, no save)", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_HELD");
    const heldLock = acquireSessionLock(dir, "scratch", "review", "vendor/m");
    assert.equal(heldLock.ok, true);
    try {
      const fake = {
        ok: true,
        text: "racing body",
        stderr: "INFO 2026 service=session id=ses_OTHER slug=foo created\n",
      };
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "concurrent",
        opencodeArgs: ["run", "--format", "default"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(result.degraded, true);
      assert.equal(result.sessionId, null,
        "degraded mode must NOT populate sessionId (continuity didn't happen)");
      assert.equal(fake._observedSessionId, null, "degraded mode must NOT pass --session");
      assert.equal(loadSessionId(dir, "scratch", "review", "vendor/m").value, "ses_HELD",
        "lock-holder's stored id must stay authoritative");
    } finally {
      heldLock.release();
    }
  } finally { cleanup(); }
});

test("dispatchOpencode: --no-session short-circuits BEFORE lock acquisition (does not contend with concurrent normal calls)", async () => {
  // Per code-review feedback: --no-session is a one-off detached call that
  // never reads or writes the .session-id file, so the lock isn't needed.
  // A normal-mode dispatch holding the lock concurrently must NOT force the
  // --no-session call into degraded mode.
  const { dir, cleanup } = makeTempRepo();
  try {
    const heldLock = acquireSessionLock(dir, "scratch", "review", "vendor/m");
    assert.equal(heldLock.ok, true, "set up: another dispatch holds the lock");
    try {
      const fake = {
        ok: true,
        text: "one-off body",
        stderr: "INFO 2026 service=session id=ses_oneoff slug=foo created\n",
      };
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "ad-hoc",
        opencodeArgs: ["run", "--format", "default"],
        noSession: true,
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, true);
      assert.equal(result.sessionId, null,
        "--no-session must report sessionId: null (no continuity attempted)");
      assert.equal(result.degraded, undefined,
        "--no-session must NOT enter degraded-mode path — it short-circuits before lock acquisition");
      assert.equal(fake._observedSessionId, null,
        "--no-session must not pass --session in argv");
    } finally {
      heldLock.release();
    }
  } finally { cleanup(); }
});

test("dispatchOpencode: error path returns sessionId: null (not undefined)", async () => {
  // Per code-review feedback (glm SF1): the error-path return must explicitly
  // set sessionId: null so callers that destructure the contract get null,
  // not undefined.
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "scratch", "review", "vendor/m", "ses_PRIOR");
    const fake = {
      ok: false,
      error: "opencode failed somehow",
      stderr: "",
    };
    await withMockSessions(dir, [
      { id: "ses_PRIOR", updated: 100, directory: dir },
    ], async () => {
      const result = await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "go",
        opencodeArgs: ["run"],
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(result.ok, false);
      assert.strictEqual(result.sessionId, null,
        "error-path must set sessionId: null explicitly (not undefined)");
      assert.equal(result.sessionKey, "scratch");
    });
  } finally { cleanup(); }
});

test("dispatchOpencode: sessionKeyOverride bypasses git rule", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    saveSessionId(dir, "custom", "review", "vendor/m", "ses_CUSTOM");
    const fake = {
      ok: true,
      text: "x",
      stderr: "INFO 2026 service=session id=ses_CUSTOM slug=foo updated\n",
    };
    await withMockSessions(dir, [
      { id: "ses_CUSTOM", updated: 300, directory: dir },
    ], async () => {
      await dispatchOpencode({
        binary: MOCK_SESSION_BIN,
        cwd: dir,
        projectDir: dir,
        role: "review",
        model: "vendor/m",
        prompt: "hi",
        opencodeArgs: ["run"],
        sessionKeyOverride: "custom",
        invokeImpl: fakeInvoke(fake),
      });
      assert.equal(fake._observedSessionId, "ses_CUSTOM");
    });
  } finally { cleanup(); }
});
