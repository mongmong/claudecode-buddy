import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

// Load a style prefix template (e.g., adversarial-review.md) to prepend to the
// canonical review framing. Friendly is the default and uses no prefix.
// Missing template file → fall back silently to friendly with a stderr warning.
function loadStylePrefix(style) {
  if (style === "friendly") return "";
  const path = join(PROMPTS_DIR, `${style}-review.md`);
  try {
    return readFileSync(path, "utf8") + "\n\n---\n\n";
  } catch (err) {
    if (err.code === "ENOENT") {
      process.stderr.write(`warn: --style ${style} template missing at ${path}; falling back to friendly\n`);
      return "";
    }
    throw err;
  }
}

const REVIEW_FRAMING = `You are a code reviewer. Review the following diff for correctness, security, consistency, and maintainability.

Output format (strict):

1. Markdown findings — numbered list. Each finding includes file:line references and a Critical / Should fix / Nice to have label.
2. A single fenced JSON trailer block (verbatim format below) at the very end of your reply.

The trailer must be valid JSON matching this shape:

\`\`\`json
{
  "verdict": "approve" | "needs-attention",
  "blockers": ["short blocker title", "another short blocker title"]
}
\`\`\`

Rules:
- "verdict" is "needs-attention" iff there is at least one Critical finding. Otherwise "approve".
- "blockers" lists only Critical findings (short titles, no detail). May be empty.
- Do NOT add any prose after the JSON block.
`;

export function buildReviewPrompt({ diff, scope, base, style = "friendly" }) {
  if (!diff || diff.trim().length === 0) {
    throw new Error("diff is empty — nothing to review");
  }
  const scopeLine =
    scope === "branch"
      ? `Scope: branch diff against base \`${base ?? "main"}\`.`
      : "Scope: working tree (uncommitted changes).";
  const stylePrefix = loadStylePrefix(style);
  return `${stylePrefix}${REVIEW_FRAMING}\n${scopeLine}\n\n--- BEGIN DIFF ---\n${diff}\n--- END DIFF ---\n`;
}
