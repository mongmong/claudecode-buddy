// Minimal shell-style argument splitter — handles single and double quotes.
// We deliberately do not implement variable expansion, escapes, or backticks.
// The caller is the slash command body, not user input.
export function splitArgs(input) {
  if (Array.isArray(input)) return input;
  const out = [];
  let i = 0;
  const s = input ?? "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n") { i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let token = "";
      while (i < s.length && s[i] !== quote) {
        token += s[i];
        i++;
      }
      i++; // skip closing quote
      out.push(token);
      continue;
    }
    let token = "";
    while (i < s.length && s[i] !== " " && s[i] !== "\t" && s[i] !== "\n") {
      token += s[i];
      i++;
    }
    out.push(token);
  }
  return out;
}
