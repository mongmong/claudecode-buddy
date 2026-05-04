const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/g;
const ALLOWED_KEYS = new Set(["verdict", "blockers"]);

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function validate(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return fail("trailer must be a JSON object");
  }
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      return fail(`trailer has unexpected additional property: ${JSON.stringify(key)}`);
    }
  }
  if (!("verdict" in obj)) return fail("trailer missing required field: verdict");
  if (obj.verdict !== "approve" && obj.verdict !== "needs-attention") {
    return fail(`trailer verdict must be "approve" or "needs-attention", got: ${JSON.stringify(obj.verdict)}`);
  }
  if (!("blockers" in obj)) return fail("trailer missing required field: blockers");
  if (!Array.isArray(obj.blockers)) return fail("trailer blockers must be an array");
  for (const b of obj.blockers) {
    if (typeof b !== "string") return fail("trailer blockers must contain only strings");
    if (b.length === 0) return fail("trailer blockers must contain non-empty strings");
  }
  return ok(obj);
}

export function extractTrailer(text) {
  const matches = [...text.matchAll(FENCE_RE)];
  if (matches.length === 0) {
    return fail("no fenced JSON trailer block found in opencode output");
  }
  const lastBlock = matches[matches.length - 1][1];
  let parsed;
  try {
    parsed = JSON.parse(lastBlock);
  } catch (err) {
    return fail(`failed to parse trailer JSON: ${err.message}`);
  }
  return validate(parsed);
}
