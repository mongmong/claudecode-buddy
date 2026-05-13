// Plan-006 Phase 2 (H2 + M1). Minimal fd-bound file-open primitive.
//
// USAGE:
//   const { fd, fstat, fdResolvedPath } = openFdBound(path);
//   try {
//     // Caller does its own validation, e.g.:
//     //   - path-based allowed-dir check (always)
//     //   - fd-resolved-path check (LINUX ONLY; fdResolvedPath is null on macOS)
//     //   - fstat.isFile() / isSymbolicLink() etc.
//     const content = readFileSync(fd, "utf8");
//     // ...
//   } finally {
//     try { closeSync(fd); } catch {}
//   }
//
// VALIDATION CONTRACT (resolves plan-006 round-2 N2):
// - Callers MUST run isUnderAllowedDir(path) (path-based) regardless of platform.
// - On Linux, callers SHOULD additionally validate fdResolvedPath against the
//   allowed base — this is the fd-bound TOCTOU defense that closes H2/M1.
// - On macOS, fdResolvedPath is null; the additional fd-bound check is skipped,
//   and macOS retains the existing symlink-swap TOCTOU known-limitation
//   (F_GETPATH-based defense queued for plan-009+).
//
// FD LEAK PREVENTION (resolves GLM + self-opus round-2 non-blocker):
// Every caller wraps fd usage in try/finally { closeSync(fd) }. The primitive
// returns the fd to the caller — the caller is responsible for closing it.
// (We deliberately do NOT close inside the primitive: callers need the fd
// alive for at least one readFileSync(fd) before closing.)

import { openSync, fstatSync, realpathSync, constants as fsConstants } from "node:fs";

// Options:
//   nofollow: if true, openSync uses O_RDONLY | O_NOFOLLOW so symlink paths
//             raise ELOOP at open time. Use this for callers that want to
//             reject ANY symlink (e.g. scope.mjs untracked-file reads, where
//             the existing pre-fd-bound defense rejected symlinks via lstat).
//             Default false matches the prior `openSync(path, "r")` behavior
//             — callers that need the fd-resolved-path check (e.g.
//             readTaskFileFdBound, readPromptFileFdBound) keep this default
//             and rely on the fd-resolved-path containment check to reject
//             symlinks that resolve outside the allowed directory.
export function openFdBound(path, { nofollow = false } = {}) {
  const flags = nofollow
    ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    : fsConstants.O_RDONLY;
  const fd = openSync(path, flags);
  const fstat = fstatSync(fd);
  let fdResolvedPath = null;
  if (process.platform === "linux") {
    try {
      fdResolvedPath = realpathSync(`/proc/self/fd/${fd}`);
    } catch {
      // /proc not mounted (rare; e.g. minimal containers) — fall back to
      // path-based-only behavior, matching the macOS code path.
      fdResolvedPath = null;
    }
  }
  return { fd, fstat, fdResolvedPath };
}
