// Plain answers for surfaces outside the app (wave 4, w4-parity-agent): the portal question box and a reply in a
// simulated chat thread. Owner: w4-parity-agent.
//
// The chat recipe asks the model to cite the result id that answers the question, and the app renders those ids as
// links into the trace. An employee in the portal or a person reading a chat thread cannot follow them, so code strips
// them (and markdown emphasis) after the grounding check has passed. Nothing else in the answer changes: the numbers
// the grounding check accepted stay exactly as written.

/** Ids of tool results, actions and artifacts the agent cites, bare, backticked or as a [res_...] marker. */
const REF = /[`[]?\b(?:res|art)_[A-Za-z0-9]+\b[`\]]?/;
const REF_G = new RegExp(REF.source, "g");
/** One id or a short list of them: "res_0001", "res_0001 and res_0002", "res_0001, res_0002". */
const LIST = `${REF.source}(?:\\s*(?:,|and|,\\s*and)\\s*${REF.source})*`;

/** Row ids a name or a noun already stands for: "Mira Delgado (wrk_0022)", "pay rate `prt_0052`". */
const ROW_ID = "(?:wrk|prt|tor|exp|prp|ofr|hir|ntc|rtr)_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PLAIN_DATE = /(?<![\w-])`?(\d{4})-(\d{2})-(\d{2})`?(?![\w-]|:\d|T\d)/g;

/**
 * Plain YYYY-MM-DD dates as "Oct 30". When the text spans more than one year every date keeps its year, so a range
 * never reads with the year on one end only.
 */
export function plainDates(text: string): string {
  const years = new Set([...text.matchAll(PLAIN_DATE)].map((m) => m[1]));
  return text.replace(PLAIN_DATE, (m, y: string, mo: string, d: string) => {
    const month = MONTHS[Number(mo) - 1];
    const day = Number(d);
    if (!month || day < 1 || day > 31) return m;
    return years.size > 1 ? `${month} ${day}, ${y}` : `${month} ${day}`;
  });
}

export function plainAnswer(text: string): string {
  let out = text;
  // A row id after the name or noun that already says it: "Mira Delgado (wrk_0022)", "pay rate `prt_0052`".
  out = out.replace(new RegExp(`\\s*\\(\\s*\`?${ROW_ID}\`?(?:\\s*,\\s*\`?${ROW_ID}\`?)*\\s*\\)`, "g"), "");
  out = out.replace(new RegExp(`\\b(pay rate|request|proposal|expense|offer|notice) \`?${ROW_ID}\`?`, "g"), "$1");
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
  // Markdown emphasis and code marks read as stray asterisks and backticks in plain text.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/`([^`\n]+)`/g, "$1");
  // A payroll run id reads as its payday: "The draft payroll pay_2026_10_30" is "The draft payroll for Oct 30".
  const day = (mo: string, d: string) => `${MONTHS[Number(mo) - 1] ?? mo} ${Number(d)}`;
  out = out.replace(/\b(payroll|run)\s+`?pay_(\d{4})_(\d{2})_(\d{2})`?/g, (_m, w: string, _y: string, mo: string, d: string) => `${w} for ${day(mo, d)}`)
    .replace(/`?\bpay_(\d{4})_(\d{2})_(\d{2})\b`?/g, (_m, _y: string, mo: string, d: string) => `the ${day(mo, d)} run`);
  out = plainDates(out);
  return out
    // A pointer left with nothing to point at: "Mira Delgado. Source: ." and "Source: tor_0003, ." lose the pointer.
    .replace(/\s*\b(?:Sources?|Cited|See):?\s*(?=[.;]|$)[.;]?/gm, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/(?<!\.)([.!?]) ?\.(?!\.)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
