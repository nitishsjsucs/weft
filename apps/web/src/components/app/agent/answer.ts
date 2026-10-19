// A chat answer as copy, at display time only. The model writes plain text with Markdown habits (**bold**, `code`,
// "- " bullets) and cites the tool results it rests on by id. The grounding check runs on the stored text, which never
// changes here; this module only decides what a person reads: a small safe Markdown subset (bold, inline code, bullet
// lists; never HTML or links), each cited result as a numbered source chip, no worker or pay rate ids after names, no
// enum codes and no ISO dates.
import { CODE_WORDS, humanDateText, humanLine } from "../copy";

export type AnswerSpan = { t: "text"; s: string } | { t: "b"; s: string } | { t: "code"; s: string } | { t: "cite"; n: number };
export interface AnswerBlock { kind: "p" | "ul"; items: AnswerSpan[][] }
export interface ParsedAnswer { blocks: AnswerBlock[]; cites: string[] }

/** A cited result or saved artifact: `res_0001`, art_ab12. */
const CITE_ID = "(?:res|art)_[A-Za-z0-9]+";
/** One citation as the model writes it: bare, backticked, bracketed or bold. */
const CITE_ONE = `(?:\\*\\*|\`|\\[)?\\b(${CITE_ID})\\b(?:\\*\\*|\`|\\])?`;
const SENTINEL = (i: number) => `\u0001${i}\u0001`;
const SENTINEL_RE = /\u0001(\d+)\u0001/g;
/** Any other row id the model may quote (people, pay rates, requests, proposals, runs). */
const OTHER_ID = "(?:wrk|prt|tor|exp|prp|ofr|hir|ntc|run|rtr|doc|cnt|pyc|psn|usr)_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*";

/** Citations become numbered sentinels (the same id keeps its number); everything else is plain text. */
function extractCites(text: string): { text: string; cites: string[] } {
  const cites: string[] = [];
  const num = (id: string) => { let i = cites.indexOf(id); if (i < 0) { cites.push(id); i = cites.length - 1; } return i; };
  let out = text;
  // A parenthetical that only points at results: "(res_0014)", "(result `res_0007`)", "(source: res_1, res_2)".
  out = out.replace(/\s*\(([^()\n]{0,100})\)/g, (all, inner: string) => {
    const ids = [...inner.matchAll(new RegExp(CITE_ID, "g"))].map((m) => m[0]);
    if (!ids.length) return all;
    const rest = inner.replace(new RegExp(CITE_ONE, "g"), "").replace(/\b(see|from|per|the|and|in|results?|search|tool|people|payroll|policy|record|source:?|sources:?|ids?)\b/gi, "").replace(/[\s,;:.`*]+/g, "");
    return rest === "" ? ` ${ids.map((id) => SENTINEL(num(id))).join("")}` : all;
  });
  // "result `res_0001`", "payroll result res_0227": the noun goes, the citation stays.
  out = out.replace(new RegExp(`\\b(?:(?:payroll|tool|people search|policy|search) )?results?\\s+(?:id\\s+)?${CITE_ONE}`, "gi"), (_m, id: string) => SENTINEL(num(id)));
  out = out.replace(new RegExp(CITE_ONE, "g"), (_m, id: string) => SENTINEL(num(id)));
  return { text: out, cites };
}

/** Words for the rest of the answer: no other ids, no enum codes, audit rows as "audit #N", dates as days. */
function wordsOnly(text: string): string {
  return humanLine(humanDateText(text
    .replace(new RegExp(`\\s*\\(\\s*\`?${OTHER_ID}\`?(?:\\s*,\\s*\`?${OTHER_ID}\`?)*\\s*\\)`, "g"), "")
    .replace(new RegExp(`\`(${OTHER_ID}|pay_\\d{4}_\\d{2}_\\d{2}|\\d{4}-\\d{2}-\\d{2}(?:T[\\d:.]+(?:Z|[+-]\\d{2}:\\d{2})?)?|\\$?[\\d,]+(?:\\.\\d+)?%?)\``, "g"), "$1")
    .replace(/\b(?:pay rate|rate) (?:prt_[A-Za-z0-9_]+)/g, "pay rate")
    .replace(/\b(?:the )?(?:audit )?action (?:with )?(?:sequence|seq\.?)(?: number)? (?:\*\*)?(\d+)(?:\*\*)?/gi, "audit #$1")
    .replace(/\b(?:audit )?(?:sequence|seq\.?) (?:\*\*)?(\d+)(?:\*\*)?/gi, "audit #$1")
    .replace(/\baudit #(\d+)\s*\(audit #\1\)/g, "audit #$1")
    .replace(/(`?)\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b\1/g, (_m, _q: string, c: string) => CODE_WORDS[c] ?? c.toLowerCase().replaceAll("_", " "))))
    .replace(/\btor\b(?=[\s,.;])/g, "the time-off request");
}

/** Leftover pointers once the ids are chips: "Source: [1]." keeps the chip; "Source: ." goes. */
function tidy(text: string): string {
  return text
    .replace(/\b(?:Sources?|Cited|See):?\s*(?=\u0001)/g, "")
    .replace(/\b(?:Sources?|Cited):?\s*(?:[,;.]\s*)+(?=$|\n|[A-Z])/gm, "")
    .replace(/\s+(\u0001\d+\u0001)/g, " $1")
    .replace(/(\u0001\d+\u0001)\s*,\s*(?=\u0001)/g, "$1")
    .replace(/(\u0001\d+\u0001)\s+(?=\u0001)/g, "$1")
    .replace(/,\s*(?=\u0001\d+\u0001\s*[.;]?\s*(?:$|\n))/gm, " ")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/([.!?])[ \t]+[.,;:](?!\d)/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
}

function inline(line: string): AnswerSpan[] {
  const out: AnswerSpan[] = [];
  const re = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|\u0001(\d+)\u0001/g;
  let at = 0;
  const text = (s: string) => { const v = s.replace(/\*\*|__/g, ""); if (v) out.push({ t: "text", s: v }); };
  for (const m of line.matchAll(re)) {
    text(line.slice(at, m.index));
    if (m[1] !== undefined) out.push({ t: "b", s: m[1] });
    else if (m[2] !== undefined) out.push({ t: "code", s: m[2] });
    else out.push({ t: "cite", n: Number(m[3]) + 1 });
    at = m.index + m[0].length;
  }
  text(line.slice(at));
  return out;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** The answer as blocks of spans; `cites` lists the cited ids in chip order (chip n is cites[n - 1]). */
export function parseAnswer(raw: string): ParsedAnswer {
  const { text, cites } = extractCites(raw.replace(/\r\n/g, "\n"));
  const lines = tidy(wordsOnly(text)).split("\n").map((l) => l.replace(/^\s{0,3}#{1,6}\s+/, "").trimEnd());
  const blocks: AnswerBlock[] = [];
  for (const l of lines) {
    if (!l.trim()) { blocks.push({ kind: "p", items: [] }); continue; }
    if (BULLET.test(l)) {
      const last = blocks[blocks.length - 1];
      const item = inline(l.replace(BULLET, ""));
      if (last?.kind === "ul") last.items.push(item); else blocks.push({ kind: "ul", items: [item] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "p" && last.items.length) last.items.push([{ t: "text", s: "\n" }, ...inline(l)]);
    else blocks.push({ kind: "p", items: [inline(l)] });
  }
  return { blocks: blocks.filter((b) => b.items.length > 0), cites };
}

/** One line of plain words for a list (Recent answers): no chips, no Markdown marks, lines joined. */
export function answerPlain(raw: string): string {
  const { blocks } = parseAnswer(raw);
  return blocks
    .flatMap((b) => b.items.map((spans) => spans.map((s) => (s.t === "cite" ? "" : s.s)).join("").replace(/\s*\n\s*/g, " ").trim()))
    .filter(Boolean)
    .join(" ")
    .replace(/([.!?])(?:\s+[.,;:](?!\d))+/g, "$1")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim()
    .replace(SENTINEL_RE, "");
}
