// Plain answers for surfaces outside the app (wave 4, w4-parity-agent): the portal question box and a reply in a
// simulated chat thread. Owner: w4-parity-agent.
//
// The chat recipe asks the model to cite the result id that answers the question, and the app renders those ids as
// links into the trace. An employee in the portal or a person reading a chat thread cannot follow them, so code strips
// them (and markdown emphasis) after the grounding check has passed. Nothing else in the answer changes: the numbers
// the grounding check accepted stay exactly as written.

/** Ids of tool results, actions and artifacts the agent cites. */
const REF = /`?\b(?:res|art)_[A-Za-z0-9]+\b`?/;
const REF_G = new RegExp(REF.source, "g");
/** One id or a short list of them: "res_0001", "res_0001 and res_0002", "res_0001, res_0002". */
const LIST = `${REF.source}(?:\\s*(?:,|and|,\\s*and)\\s*${REF.source})*`;

export function plainAnswer(text: string): string {
  let out = text;
  // A short parenthetical that only points at results: "(res_0014)", "(result `res_0007`)", "(People search result res_0016)".
  out = out.replace(/\s*\(([^()]{0,80})\)/g, (all, inner: string) => {
    if (!REF.test(inner)) return all;
    const rest = inner.replace(REF_G, "").replace(/\b(see|from|per|the|and|results?|search|tool|people|payroll|policy|record|source:?|ids?)\b/gi, "").replace(/[\s,;:.]+/g, "");
    return rest === "" ? "" : ` (${inner.replace(/,?\s*(?:results?\s+)?`?\b(?:res|art)_[A-Za-z0-9]+\b`?/g, "").trim()})`;
  });
  // An inline pointer: "Source: Expense policy v1, result `res_0006`." keeps the source and drops the id. A bare id that
  // is part of the sentence ("res_0001 shows it") stays, so a sentence never loses its subject.
  out = out.replace(new RegExp(`,?\\s*(?:\\b(?:see|in|from)\\s+)?\\bresults?\\s+${LIST}`, "gi"), "");
  out = out.replace(new RegExp(`,?\\s+${LIST}(?=\\s*(?:[.;!?]|$))`, "gm"), "");
  // Markdown emphasis reads as stray asterisks in plain text.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1");
  return out
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/(?<!\.)([.!?]) ?\.(?!\.)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
