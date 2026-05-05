// Tests for the --variant flag added in v0.5.0.
//
// --variant <level> forwards opencode's reasoning-effort variant flag verbatim
// to the underlying provider (e.g. "high", "max", "minimal"). The plugin does
// not validate the value — opencode + the provider decide what's accepted —
// so tests focus on:
//   1. Parser accepts --variant on review, run, prompt subcommands.
//   2. Missing value rejected with exit 2 + clear error.
//   3. The flag is actually forwarded to the spawned opencode binary's argv.
//   4. Default behavior (no --variant) does NOT include --variant in argv.
//   5. parseRunArgs duplicate-flag guard catches `--variant a --variant b`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCompanion, makeTempRepo } from "./helpers.mjs";

const RECORD_BIN = resolve("tests/opencode/fixtures/mock-opencode-record-args.mjs");

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function setupRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "init", "-q");
}

function recordPath() {
  const recordDir = mkdtempSync(join(tmpdir(), "opencode-record-"));
  return {
    path: join(recordDir, "argv.jsonl"),
    cleanup: () => rmSync(recordDir, { recursive: true, force: true }),
  };
}

function readRecordedArgv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  // Each invocation appends one JSON-encoded argv array. Filter out:
  //   - --version probes from cli-detection
  //   - `session list` follow-up calls dispatchOpencode makes to capture the
  //     session id after a successful run (we only care about the primary
  //     `run` invocation that received the user's flags).
  return lines
    .map((l) => JSON.parse(l))
    .filter((argv) => !argv.includes("--version") && argv[0] === "run");
}

// ----- review subcommand -----

test("review forwards --variant to opencode argv", async () => {
  const { dir, cleanup: cleanupRepo } = makeTempRepo();
  const { path: argPath, cleanup: cleanupRecord } = recordPath();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree", "--model", "vendor/m1", "--variant", "high"],
      { OPENCODE_BIN: RECORD_BIN, OPENCODE_REPO_ROOT: dir, OPENCODE_RECORD_ARGS_PATH: argPath },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const invocations = readRecordedArgv(argPath);
    assert.ok(invocations.length >= 1, `expected at least 1 opencode invocation, got: ${invocations.length}`);
    const argv = invocations[invocations.length - 1];
    const variantIdx = argv.indexOf("--variant");
    assert.ok(variantIdx >= 0, `expected --variant in argv, got: ${JSON.stringify(argv)}`);
    assert.equal(argv[variantIdx + 1], "high");
  } finally {
    cleanupRecord();
    cleanupRepo();
  }
});

test("review without --variant does NOT include --variant in opencode argv", async () => {
  const { dir, cleanup: cleanupRepo } = makeTempRepo();
  const { path: argPath, cleanup: cleanupRecord } = recordPath();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--scope", "working-tree", "--model", "vendor/m1"],
      { OPENCODE_BIN: RECORD_BIN, OPENCODE_REPO_ROOT: dir, OPENCODE_RECORD_ARGS_PATH: argPath },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const invocations = readRecordedArgv(argPath);
    const argv = invocations[invocations.length - 1];
    assert.ok(!argv.includes("--variant"), `unexpected --variant in argv: ${JSON.stringify(argv)}`);
  } finally {
    cleanupRecord();
    cleanupRepo();
  }
});

test("review --variant with no value is rejected with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    writeFileSync(join(dir, "x.txt"), "change\n");
    const result = await runCompanion(
      ["review", "--variant"],
      { OPENCODE_BIN: RECORD_BIN, OPENCODE_REPO_ROOT: dir },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--variant requires a value/i);
  } finally {
    cleanup();
  }
});

// ----- run subcommand -----

test("run forwards --variant to opencode argv (foreground)", async () => {
  const { dir, cleanup: cleanupRepo } = makeTempRepo();
  const { path: argPath, cleanup: cleanupRecord } = recordPath();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "fix it", "--yolo", "--model", "vendor/m1", "--variant", "minimal", "--no-session"],
      { OPENCODE_BIN: RECORD_BIN, OPENCODE_REPO_ROOT: dir, OPENCODE_RECORD_ARGS_PATH: argPath, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const invocations = readRecordedArgv(argPath);
    assert.ok(invocations.length >= 1);
    const argv = invocations[invocations.length - 1];
    const variantIdx = argv.indexOf("--variant");
    assert.ok(variantIdx >= 0, `expected --variant in argv, got: ${JSON.stringify(argv)}`);
    assert.equal(argv[variantIdx + 1], "minimal");
  } finally {
    cleanupRecord();
    cleanupRepo();
  }
});

test("run --variant with no value is rejected with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "fix it", "--variant"],
      { OPENCODE_BIN: RECORD_BIN, OPENCODE_REPO_ROOT: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--variant requires a value/i);
  } finally {
    cleanup();
  }
});

test("run rejects duplicate --variant flag with exit 2", async () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["run", "--task", "fix it", "--variant", "high", "--variant", "max"],
      { OPENCODE_BIN: RECORD_BIN, OPENCODE_REPO_ROOT: dir, OPENCODE_BUDDY_FORCE_INTERACTIVE: "1" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /duplicate flag: --variant/i);
  } finally {
    cleanup();
  }
});

// ----- prompt subcommand -----

test("prompt forwards --variant to opencode argv", async () => {
  const { dir, cleanup: cleanupRepo } = makeTempRepo();
  const { path: argPath, cleanup: cleanupRecord } = recordPath();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["prompt", "--model", "vendor/m1", "--variant", "max", "what is 2+2"],
      { OPENCODE_BIN: RECORD_BIN, OPENCODE_REPO_ROOT: dir, OPENCODE_RECORD_ARGS_PATH: argPath },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const invocations = readRecordedArgv(argPath);
    assert.ok(invocations.length >= 1);
    const argv = invocations[invocations.length - 1];
    const variantIdx = argv.indexOf("--variant");
    assert.ok(variantIdx >= 0, `expected --variant in argv, got: ${JSON.stringify(argv)}`);
    assert.equal(argv[variantIdx + 1], "max");
  } finally {
    cleanupRecord();
    cleanupRepo();
  }
});

test("prompt falls back to OPENCODE_VARIANT env var when --variant is omitted", async () => {
  const { dir, cleanup: cleanupRepo } = makeTempRepo();
  const { path: argPath, cleanup: cleanupRecord } = recordPath();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["prompt", "--model", "vendor/m1", "what is 2+2"],
      {
        OPENCODE_BIN: RECORD_BIN,
        OPENCODE_REPO_ROOT: dir,
        OPENCODE_RECORD_ARGS_PATH: argPath,
        OPENCODE_VARIANT: "high",
      },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const invocations = readRecordedArgv(argPath);
    const argv = invocations[invocations.length - 1];
    const variantIdx = argv.indexOf("--variant");
    assert.ok(variantIdx >= 0, `expected --variant from env var, got: ${JSON.stringify(argv)}`);
    assert.equal(argv[variantIdx + 1], "high");
  } finally {
    cleanupRecord();
    cleanupRepo();
  }
});

test("prompt --variant flag wins over OPENCODE_VARIANT env var", async () => {
  const { dir, cleanup: cleanupRepo } = makeTempRepo();
  const { path: argPath, cleanup: cleanupRecord } = recordPath();
  try {
    setupRepo(dir);
    const result = await runCompanion(
      ["prompt", "--model", "vendor/m1", "--variant", "minimal", "hi"],
      {
        OPENCODE_BIN: RECORD_BIN,
        OPENCODE_REPO_ROOT: dir,
        OPENCODE_RECORD_ARGS_PATH: argPath,
        OPENCODE_VARIANT: "max",
      },
    );
    assert.equal(result.code, 0);
    const invocations = readRecordedArgv(argPath);
    const argv = invocations[invocations.length - 1];
    const variantIdx = argv.indexOf("--variant");
    assert.ok(variantIdx >= 0);
    assert.equal(argv[variantIdx + 1], "minimal");
  } finally {
    cleanupRecord();
    cleanupRepo();
  }
});
