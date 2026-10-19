// Server text as copy, at display time only. Tool outcomes, routine summaries, flag notes, policy and coverage checks
// and proposal diffs are stored as the engine wrote them (base world digests and evals pin them), and they carry row
// ids, enum codes and ISO dates that mean nothing to a person. These helpers turn them into words; the stored text
// never changes.
import { fmtDate, humanDates, humanTimes } from "./format";

const ID = "[a-z]{2,5}_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*";
/** Words for the engine's codes that can appear in flag text. */
export const CODE_WORDS: Record<string, string> = { WAITING_PERIOD: "the policy's waiting period", INSUFFICIENT_BALANCE: "the balance", USE_CAP: "the yearly use cap" };

const PLAIN = "\\d{4}-\\d{2}-\\d{2}";
const DATE_LIST = new RegExp(`(?<![\\w-])${PLAIN}(?:,\\s*${PLAIN})+(?![\\w-]|:\\d|T\\d)`, "g");
const dayOf = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/**
 * A comma list of plain dates reads as a run or a list: "2026-11-23, 2026-11-24, 2026-11-25" is "Nov 23 to Nov 25",
 * "2026-11-23, 2026-11-25" is "Nov 23 and Nov 25". Dates in the text's latest year read without one.
 */
export function humanDateLists(text: string, year?: number): string {
  const years = [...text.matchAll(/(?<![\w-])(\d{4})-\d{2}-\d{2}/g)].map((m) => Number(m[1]));
  const ref = year ?? (years.length ? Math.max(...years) : undefined);
  return text.replace(DATE_LIST, (m) => {
    const ds = m.split(/,\s*/);
    const one = (d: string) => humanDates(d, ref);
    const consecutive = ds.length > 2 && ds.every((d, i) => i === 0 || dayOf(d) - dayOf(ds[i - 1]!) === 86_400_000);
    if (consecutive) return `${one(ds[0]!)} to ${one(ds[ds.length - 1]!)}`;
    return `${ds.slice(0, -1).map(one).join(", ")} and ${one(ds[ds.length - 1]!)}`;
  });
}

/** Instants, plain dates and date lists in server text as words, and nothing else changed (ids and codes stay). */
export function humanDateText(text: string, year?: number): string {
  return humanDates(humanTimes(humanDateLists(text, year)), year);
}

/**
 * Flag and check text as copy: instants in Pacific time, plain dates as "Oct 19", no row ids (a parenthesized id list
 * goes, an id the sentence leans on becomes words) and engine codes as words.
 */
export function humanCopy(text: string, year?: number): string {
  return humanDates(humanTimes(humanDateLists(text, year)), year)
    .replace(new RegExp(`\\s*\\((?:${ID})(?:,\\s*${ID})*\\)`, "g"), "")
    .replace(new RegExp(`\\bafter pay rate ${ID} took effect`, "g"), "after the new pay rate took effect")
    .replace(/\s*\(action \d+\)/g, "")
    .replace(new RegExp(`;\\s*pay rate ${ID} effective`, "g"), "; new pay rate from")
    .replace(new RegExp(`\\b(in|from|Was in) (?:the previous run )?pay_[A-Za-z0-9_]+`, "g"), (_m, w: string) => `${w} the previous run`)
    .replace(new RegExp(`\\btor_\\d+ \\(`, "g"), "A time-off request (")
    .replace(new RegExp(`\\b${ID}\\b`, "g"), "")
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (c) => CODE_WORDS[c] ?? c.toLowerCase().replaceAll("_", " "))
    .replace(/ {2,}/g, " ").replace(/ ([,.;)])/g, "$1").replace(/\( /g, "(").trim();
}

/** What a bare id stands for in a sentence ("Drafted response 1 for ntc_0005" is "... for the notice"). */
const ID_NOUN: Record<string, string> = {
  ntc: "the notice", prp: "the proposal", wrk: "the person", exp: "the expense", run: "the run", res: "the result", rtr: "the routine run",
  tor: "the time-off request", art: "the saved result", ofr: "the offer", hir: "the hire", doc: "the document",
};
/** Nouns that already name the id after them ("DE 2088 notice ntc_0005"): the id goes, the noun stays. */
const NAMED = "notice|worker|person|proposal|run|expense|request|routine run|result|offer|document";
const KNOWN = Object.keys(ID_NOUN).join("|");

/**
 * A tool's step line, a routine's summary or a proposal headline as copy. Times and dates read as on the payroll page,
 * a payroll run id reads as its payday ("the Oct 30 run"), parenthesized id lists and action numbers go, an id after
 * the noun it names goes, and a bare id becomes its noun. Ids of kinds not listed here stay as written.
 */
export function humanLine(text: string): string {
  return humanDates(humanTimes(humanDateLists(text)))
    .replace(new RegExp(`\\s*\\((?:${ID}|#\\d+)(?:,\\s*(?:${ID}|#\\d+))*\\)`, "g"), "")
    .replace(/\b(?:(?:the|pay|payroll) )?(?:run )?pay_(\d{4})_(\d{2})_(\d{2})\b/g, (_m, y: string, mo: string, d: string) => `the ${fmtDate(`${y}-${mo}-${d}`)} run`)
    .replace(new RegExp(`\\b(${NAMED}) (?:${KNOWN})_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*\\b`, "g"), "$1")
    .replace(new RegExp(`\\b(?:the )?(${KNOWN})_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*\\b`, "g"), (_m, k: string) => ID_NOUN[k]!)
    .replace(/ {2,}/g, " ").replace(/ ([,.;:)])/g, "$1").replace(/;\s*;/g, ";").trim();
}

/** A stored enum value as words: "in_review" is "in review", "needs_info to active" is "needs info to active". */
export function enumWords(value: string): string {
  return value.replace(/(^|\s)([a-z]+(?:_[a-z]+)+)(?=\s|$)/g, (_m, p: string, w: string) => `${p}${w.replaceAll("_", " ")}`);
}

/**
 * A notice named by its form: "DE 2088" reads "DE 2088 notice". A form code that is already a phrase ending in
 * "notice" (the NY "UI rate notice") stays as it is, so the word is never doubled.
 */
export function noticeName(formCode: string | null | undefined): string {
  const f = (formCode ?? "").trim();
  if (!f) return "Agency notice";
  return /\bnotice$/i.test(f) ? f : `${f} notice`;
}

/** The one label for a row of the audit log, wherever a page links to it. */
export const auditLabel = (seq: number): string => `audit #${seq}`;
