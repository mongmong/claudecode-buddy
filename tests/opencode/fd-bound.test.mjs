// Plan-006 Phase 2 (H2 + M1).
//
// openFdBound is a minimal primitive that opens a file and returns:
//   - fd: the open file descriptor (caller MUST closeSync, ideally in try/finally)
//   - fstat: the fstat result on the fd (use to check isFile / isSymbolicLink etc)
//   - fdResolvedPath: realpathSync('/proc/self/fd/<fd>') on Linux, null on non-Linux
//
// The validation contract:
//   - Callers ALWAYS run their own path-based check (e.g. isUnderAllowedDir).
//   - On Linux, callers ADDITIONALLY validate fdResolvedPath against the
//     allowed base — this is the fd-bound TOCTOU defense.
//   - On macOS, fdResolvedPath is null; callers skip the additional fd-bound
//     check (existing TOCTOU known-limitation; F_GETPATH-based defense queued
//     for plan-009+).
//
// These tests are LINUX-ONLY because they assert on /proc/self/fd/ resolution.
// macOS callers fall back to path-based behavior with no fd-bound upgrade.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, openSync, closeSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFdBound } from "../../plugins/opencode/scripts/lib/fd-bound.mjs";

const isLinux = process.platform === "linux";

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "fd-bound-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("openFdBound returns {fd, fstat, fdResolvedPath} for a regular file", { skip: !isLinux }, () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const path = join(dir, "file.txt");
    writeFileSync(path, "hello\n");
    const result = openFdBound(path);
    try {
      assert.equal(typeof result.fd, "number", "fd should be a number");
      assert.equal(result.fstat.isFile(), true, "fstat should report regular file");
      assert.equal(result.fstat.isSymbolicLink(), false);
      assert.equal(typeof result.fdResolvedPath, "string", "Linux: fdResolvedPath should be a string");
      assert.match(result.fdResolvedPath, /file\.txt$/, "fdResolvedPath should resolve to original file");
      // Reading via the fd should return the original content.
      assert.equal(readFileSync(result.fd, "utf8"), "hello\n");
    } finally {
      closeSync(result.fd);
    }
  } finally {
    cleanup();
  }
});

test("openFdBound: fd binds to original inode across symlink-swap (H2 TOCTOU defense)", { skip: !isLinux }, () => {
  // This is the core test for H2. Sequence:
  //   1. Create file A with content "safe-content".
  //   2. Create file B (elsewhere) with content "dangerous-content".
  //   3. openFdBound(A) → get fd.
  //   4. POST-OPEN, PRE-READ swap: rmSync(A); symlinkSync(B, A).
  //      Now A is a symlink → B; path-based readFileSync(A) would return
  //      "dangerous-content".
  //   5. readFileSync(fd) returns "safe-content" — fd is bound to A's
  //      original inode, the symlink doesn't affect it.
  //   6. fdResolvedPath still resolves to A's original path (the
  //      deleted-but-fd-held inode). On Linux, /proc/self/fd/<fd>
  //      shows "<original-path> (deleted)" after rm but still resolves
  //      to the inode for read purposes.
  const { dir, cleanup } = makeTempDir();
  try {
    const pathA = join(dir, "A.txt");
    const pathB = join(dir, "B.txt");
    writeFileSync(pathA, "safe-content");
    writeFileSync(pathB, "dangerous-content");

    const result = openFdBound(pathA);
    try {
      // The deterministic swap: rm A, replace with symlink to B.
      unlinkSync(pathA);
      symlinkSync(pathB, pathA);

      // Path-based read would now return "dangerous-content".
      assert.equal(readFileSync(pathA, "utf8"), "dangerous-content",
        "sanity check: path-based read DOES follow the swap");

      // Fd-based read returns "safe-content" (bound to original inode).
      assert.equal(readFileSync(result.fd, "utf8"), "safe-content",
        "TOCTOU defense: fd-bound read returns original content despite the swap");
    } finally {
      closeSync(result.fd);
    }
  } finally {
    cleanup();
  }
});

test("openFdBound returns isSymbolicLink=false for a symlink target (openSync follows symlinks)", { skip: !isLinux }, () => {
  // openSync follows symlinks by default — fstatSync(fd) sees the TARGET file,
  // not the symlink itself. This matches Node's default behavior; callers
  // who want to reject symlinks must check lstatSync(path) FIRST, separately.
  const { dir, cleanup } = makeTempDir();
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "target content");
    symlinkSync(target, link);

    const result = openFdBound(link);
    try {
      assert.equal(result.fstat.isFile(), true, "fstat on fd sees target as file");
      assert.equal(result.fstat.isSymbolicLink(), false, "fstat on fd does NOT see symlink (openSync followed)");
      assert.equal(readFileSync(result.fd, "utf8"), "target content");
    } finally {
      closeSync(result.fd);
    }
  } finally {
    cleanup();
  }
});

test("openFdBound with nofollow:true throws ELOOP on a symlink (M1 untracked-symlink defense)", { skip: !isLinux }, () => {
  // The scope.mjs untracked-file reader uses nofollow:true so the pre-fd-bound
  // "reject ANY symlink via lstatSync" defense is preserved at open time.
  // O_NOFOLLOW raises ELOOP on Linux + macOS when the target path is a symlink.
  const { dir, cleanup } = makeTempDir();
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "target content");
    symlinkSync(target, link);
    assert.throws(() => openFdBound(link, { nofollow: true }), /ELOOP/);
  } finally {
    cleanup();
  }
});

test("openFdBound with nofollow:false (default) follows symlinks (readTaskFile/readPromptFile contract)", { skip: !isLinux }, () => {
  // The --task-file / --prompt-file readers rely on the fd-resolved-path
  // check to reject symlinks pointing OUTSIDE the allowed dir; symlinks
  // pointing INSIDE the allowed dir are allowed to be followed.
  const { dir, cleanup } = makeTempDir();
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "target content");
    symlinkSync(target, link);
    const result = openFdBound(link);  // no nofollow — default false
    try {
      assert.equal(readFileSync(result.fd, "utf8"), "target content",
        "default (nofollow:false) follows the symlink");
    } finally {
      closeSync(result.fd);
    }
  } finally {
    cleanup();
  }
});

test("openFdBound throws on missing file", { skip: !isLinux }, () => {
  const { dir, cleanup } = makeTempDir();
  try {
    assert.throws(() => openFdBound(join(dir, "nonexistent.txt")), /ENOENT/);
  } finally {
    cleanup();
  }
});

test("readUntrackedAsDiff: fd-bound read inlines original content of pre-existing file (regression coverage)", { skip: !isLinux }, async () => {
  // Regression: ensure the refactor to fd-bound read didn't break the normal
  // happy path. An untracked file with regular content should still appear
  // inline in the diff produced by getDiff working-tree scope.
  const { execFileSync } = await import("node:child_process");
  const { makeTempRepo } = await import("./helpers.mjs");
  const { getDiff } = await import("../../plugins/opencode/scripts/lib/scope.mjs");
  const { dir, cleanup } = makeTempRepo();
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "init"], { cwd: dir });
    writeFileSync(join(dir, "untracked.txt"), "untracked content\n");
    const result = getDiff({ cwd: dir, scope: "working-tree", base: "main" });
    assert.equal(result.ok, true);
    assert.match(result.value, /untracked content/);
    assert.match(result.value, /\+\+\+ b\/untracked\.txt/);
  } finally {
    cleanup();
  }
});

test("openFdBound throws on directory", { skip: !isLinux }, () => {
  // Trying to open a directory as a file is an EISDIR error from Node's fs.
  // The caller should expect this and fail gracefully.
  const { dir, cleanup } = makeTempDir();
  try {
    // openSync on a directory raises EISDIR or O_DIRECTORY-related error
    // depending on the platform / flags. We just want any error.
    assert.throws(() => {
      const result = openFdBound(dir);
      // If somehow it succeeded, we'd need to read from a dir fd, which fails.
      try { readFileSync(result.fd); } finally { closeSync(result.fd); }
    });
  } finally {
    cleanup();
  }
});
