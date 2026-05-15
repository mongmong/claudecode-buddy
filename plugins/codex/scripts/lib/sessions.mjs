import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const PLAN_BRANCH_RE = /^feature\/plan-(\d+)(?:-|$)/;
const SAFE_COMPONENT_RE = /^[a-z0-9-]+$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitiseLabel(s) {
  if (typeof s !== "string") return "unnamed";
  const lowered = s.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, "-");
  const trimmed = replaced.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : "unnamed";
}

export function deriveSessionKey({ branch, override }) {
  if (typeof override === "string" && override.length > 0) {
    return sanitiseLabel(override);
  }
  if (typeof branch === "string" && branch.length > 0) {
    const m = PLAN_BRANCH_RE.exec(branch);
    if (m) return `plan-${m[1]}`;
    return `branch-${sanitiseLabel(branch)}`;
  }
  return "scratch";
}

export function detectGitBranch(cwd) {
  try {
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export function currentSessionKey({ cwd, override }) {
  return deriveSessionKey({ branch: detectGitBranch(cwd), override: override ?? null });
}

export function sessionFilePath(projectDir, key, role, model) {
  const safeKey = SAFE_COMPONENT_RE.test(key) ? key : sanitiseLabel(key);
  const safeRole = SAFE_COMPONENT_RE.test(role) ? role : sanitiseLabel(role);
  const safeModel = sanitiseLabel(model);
  return join(
    projectDir,
    ".claudecode-buddy",
    "opencode",
    "sessions",
    `${safeKey}-${safeRole}-${safeModel}.session-id`,
  );
}

export function sessionLockPath(projectDir, key, role, model) {
  const sessionPath = sessionFilePath(projectDir, key, role, model);
  return sessionPath.replace(/\.session-id$/, ".lock");
}

export function loadSessionId(projectDir, key, role, model) {
  const path = sessionFilePath(projectDir, key, role, model);
  if (!existsSync(path)) return { ok: true, value: null };
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return { ok: true, value: null };
    if (!SESSION_ID_RE.test(raw)) {
      return { ok: false, error: `corrupt session-id at ${path}: ${JSON.stringify(raw.slice(0, 64))}` };
    }
    return { ok: true, value: raw };
  } catch (err) {
    return { ok: false, error: `failed to read ${path}: ${err.message}` };
  }
}

export function saveSessionId(projectDir, key, role, model, sessionId) {
  const trimmed = (sessionId ?? "").trim();
  if (trimmed.length === 0) return { ok: false, error: "saveSessionId: empty sessionId" };
  if (!SESSION_ID_RE.test(trimmed)) {
    return {
      ok: false,
      error: `saveSessionId: sessionId must be a UUID; got ${JSON.stringify(trimmed.slice(0, 64))}`,
    };
  }
  const path = sessionFilePath(projectDir, key, role, model);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, trimmed);
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to write ${path}: ${err.message}` };
  }
}

export function deleteSessionId(projectDir, key, role, model) {
  const path = sessionFilePath(projectDir, key, role, model);
  if (!existsSync(path)) return { ok: true };
  try {
    rmSync(path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to delete ${path}: ${err.message}` };
  }
}

export function listSessions(projectDir) {
  const sessionsDir = join(projectDir, ".claudecode-buddy", "codex", "sessions");
  if (!existsSync(sessionsDir)) return { ok: true, value: [] };
  try {
    const records = [];
    for (const entry of readdirSync(sessionsDir)) {
      if (!entry.endsWith(".session-id") || entry.includes(".tmp.")) continue;
      const path = join(sessionsDir, entry);
      let sessionId;
      try {
        sessionId = readFileSync(path, "utf8").trim();
      } catch {
        continue;
      }
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const stat = statSync(path);
      records.push({ sessionId, path, mtimeMs: stat.mtimeMs });
    }
    records.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, value: records };
  } catch (err) {
    return { ok: false, error: `listSessions failed: ${err.message}` };
  }
}

// Pure mkdir-EEXIST lock primitive. No staleness check, no reclamation, no
// token-file. POSIX guarantees exactly one concurrent mkdir succeeds. Stranded
// locks (process crashed without releasing) require manual `rm` — error
// message includes the rm command. Auto-reclamation queued for plan 004 with
// proper flock(2) primitives.
export function acquireSessionLock(projectDir, key, role, model) {
  const path = sessionLockPath(projectDir, key, role, model);
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    mkdirSync(path);
  } catch (err) {
    if (err.code === "EEXIST") {
      return {
        ok: false,
        error:
          `locked: another opencode dispatch holds the session lock at ${path}. ` +
          `If no dispatch is actually running (previous process crashed), remove ` +
          `the lock manually with: rm -rf "${path}"`,
      };
    }
    return { ok: false, error: `lock mkdir failed: ${err.message}` };
  }
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
    },
  };
}
