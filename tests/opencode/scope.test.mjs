import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTempRepo } from "./helpers.mjs";
import { resolveScope, getDiff } from "../../plugins/opencode/scripts/lib/scope.mjs";

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function initRepo(dir, mainBranch = "main") {
  git(dir, "init", "-q", "-b", mainBranch);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "init", "-q");
}

test("resolveScope.ok defaults to working-tree when scope is auto and there are uncommitted changes", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    writeFileSync(join(dir, "x.txt"), "hi\n");
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "working-tree");
  } finally {
    cleanup();
  }
});

test("resolveScope picks branch when scope is auto and working tree is clean but commits diverge from base", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "feature.txt"), "added on feature\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feature commit");
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "branch");
    assert.equal(resolved.value.base, "main");
  } finally {
    cleanup();
  }
});

test("resolveScope honors an explicit working-tree scope even when working tree is clean", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const resolved = resolveScope({ cwd: dir, scope: "working-tree", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "working-tree");
  } finally {
    cleanup();
  }
});

test("resolveScope reports an error when cwd is not a git repo", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /git/i);
  } finally {
    cleanup();
  }
});

test("resolveScope reports an error when base ref does not exist (branch scope)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const resolved = resolveScope({ cwd: dir, scope: "branch", base: "nonexistent-ref" });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /base/i);
  } finally {
    cleanup();
  }
});

test("resolveScope auto + clean-tree + missing-base surfaces an error (no silent fall-through)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "nonexistent-ref" });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /nonexistent-ref/);
    assert.match(resolved.error, /clean/i);
  } finally {
    cleanup();
  }
});

test("resolveScope auto + clean-tree + clean-vs-base returns working-tree (genuine no-op)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const resolved = resolveScope({ cwd: dir, scope: "auto", base: "main" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.scope, "working-tree");
  } finally {
    cleanup();
  }
});

test("getDiff includes staged, unstaged, AND untracked file CONTENT for working-tree scope", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "tracked content\n");
    git(dir, "add", "a.txt");
    writeFileSync(join(dir, "b.txt"), "untracked content\n");
    const result = getDiff({ cwd: dir, scope: "working-tree" });
    assert.equal(result.ok, true);
    assert.match(result.value, /a\.txt/);
    assert.match(result.value, /tracked content/);
    assert.match(result.value, /b\.txt/);
    assert.match(result.value, /untracked content/);
  } finally {
    cleanup();
  }
});

test("getDiff skips binary untracked files and oversized untracked files", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    writeFileSync(join(dir, "huge.txt"), "x".repeat(1024 * 1024 + 1));
    writeFileSync(join(dir, "small.txt"), "fine\n");
    const result = getDiff({ cwd: dir, scope: "working-tree" });
    assert.equal(result.ok, true);
    assert.match(result.value, /small\.txt/);
    assert.doesNotMatch(result.value, /binary content/);
    assert.match(result.value, /binary\.bin.*skipped/i);
    assert.match(result.value, /huge\.txt.*skipped/i);
  } finally {
    cleanup();
  }
});

test("getDiff returns branch diff when scope is branch", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "c.txt"), "new content\n");
    git(dir, "add", "c.txt");
    git(dir, "commit", "-q", "-m", "feature");
    const result = getDiff({ cwd: dir, scope: "branch", base: "main" });
    assert.equal(result.ok, true);
    assert.match(result.value, /c\.txt/);
    assert.match(result.value, /new content/);
  } finally {
    cleanup();
  }
});

test("getDiff skips untracked symlinks WITHOUT following them (CVE-style file disclosure defense)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    // Write a sensitive-content file outside the repo, then symlink to it from inside.
    // If readUntrackedAsDiff used statSync, it would follow the link and inline the
    // sensitive content. With lstatSync, the symlink is detected and skipped.
    const { dir: outsideDir, cleanup: outsideCleanup } = makeTempRepo();
    try {
      writeFileSync(join(outsideDir, "sensitive.txt"), "VERY-SECRET-CONTENT\n");
      symlinkSync(join(outsideDir, "sensitive.txt"), join(dir, "leak"));
      const result = getDiff({ cwd: dir, scope: "working-tree" });
      assert.equal(result.ok, true);
      // The symlink path itself is mentioned (acknowledged in the diff body).
      assert.match(result.value, /leak.*skipped.*symlink/i);
      // The TARGET content must NOT appear.
      assert.doesNotMatch(result.value, /VERY-SECRET-CONTENT/,
        `symlink target was followed and content leaked into the diff!`);
    } finally {
      outsideCleanup();
    }
  } finally {
    cleanup();
  }
});

test("getDiff handles paths with spaces and shell metacharacters safely", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const trickyPath = "weird $name; rm -rf x.txt";
    writeFileSync(join(dir, trickyPath), "safe\n");
    const result = getDiff({ cwd: dir, scope: "working-tree" });
    assert.equal(result.ok, true);
    assert.match(result.value, /weird/);
    assert.match(result.value, /safe/);
  } finally {
    cleanup();
  }
});

test("getDiff with branch scope on identical trees returns ok with empty value", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    git(dir, "checkout", "-q", "-b", "feature");
    // No new commits or changes — feature is identical to main.
    const result = getDiff({ cwd: dir, scope: "branch", base: "main" });
    assert.equal(result.ok, true);
    assert.equal(result.value.trim(), "");
  } finally {
    cleanup();
  }
});

test("getDiff returns an error when git fails (e.g., bad base ref)", () => {
  const { dir, cleanup } = makeTempRepo();
  try {
    initRepo(dir);
    const result = getDiff({ cwd: dir, scope: "branch", base: "nonexistent-ref" });
    assert.equal(result.ok, false);
    assert.match(result.error, /git/i);
  } finally {
    cleanup();
  }
});
