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

export function buildReviewPrompt({ diff, scope, base }) {
  if (!diff || diff.trim().length === 0) {
    throw new Error("diff is empty — nothing to review");
  }
  const scopeLine =
    scope === "branch"
      ? `Scope: branch diff against base \`${base ?? "main"}\`.`
      : "Scope: working tree (uncommitted changes).";
  return `${REVIEW_FRAMING}\n${scopeLine}\n\n--- BEGIN DIFF ---\n${diff}\n--- END DIFF ---\n`;
}
