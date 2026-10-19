// Server text as copy, at display time only. Tool outcomes, routine summaries, flag notes, policy and coverage checks
// and proposal diffs are stored as the engine wrote them (base world digests and evals pin them), and they carry row
// ids, enum codes and ISO dates that mean nothing to a person. These helpers turn them into words; the stored text
// never changes.
import { fmtDate, humanDates, humanTimes, statusLabel, textYear } from "./format";
import { RULE_LABEL as RULE_WORDS } from "./expenses/labels";

const ID = "[a-z]{2,5}_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*";
/** Words for the engine's codes that can appear in flag text. */
export const CODE_WORDS: Record<string, string> = { WAITING_PERIOD: "the policy's waiting period", INSUFFICIENT_BALANCE: "the balance", USE_CAP: "the yearly use cap" };

const PLAIN = "\\d{4}-\\d{2}-\\d{2}";
const DATE_LIST = new RegExp(`(?<![\\w-])${PLAIN}(?:,\\s*${PLAIN})+(?![\\w-]|:\\d|T\\d)`, "g");
const dayOf = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/**
 * A comma list of plain dates reads as a run or a list: "2026-11-23, 2026-11-24, 2026-11-25" is "Nov 23 to Nov 25",
 * "2026-11-23, 2026-11-25" is "Nov 23 and Nov 25". Dates read without a year only when the text has one year.
 */
export function humanDateLists(text: string, year?: number): string {
  const ref = year ?? textYear(text);
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
    .replace(/\bas exp_[A-Za-z0-9_]+ \((\w+)\)/g, "as an earlier claim ($1)")
    .replace(new RegExp(`\\b${ID}\\b`, "g"), "")
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (c) => CODE_WORDS[c] ?? c.toLowerCase().replaceAll("_", " "))
    .replace(/ {2,}/g, " ").replace(/ ([,.;)])/g, "$1").replace(/\( /g, "(").trim();
}

/** What a bare id stands for in a sentence ("Drafted response 1 for ntc_0005" is "... for the notice"). */
const ID_NOUN: Record<string, string> = {
  ntc: "the notice", prp: "the proposal", wrk: "the person", exp: "the expense", run: "the run", res: "the result", rtr: "the routine run",
  tor: "the time-off request", art: "the saved result", ofr: "the offer", offr: "the offer", hir: "the hire", doc: "the document",
  mnt: "the mention", txa: "the tax account", hnd: "the hand-off", simc: "the chat message", etr: "the rate", prt: "the pay rate",
  sima: "the registration", simd: "the device order", itac: "the account",
};
/** Nouns that already name the id after them ("DE 2088 notice ntc_0005"): the id goes, the noun stays. */
const NAMED = "notice|worker|person|proposal|run|expense|request|routine run|result|offer|document|mention|rate|pay rate|account|hand-off|message";
const KNOWN = Object.keys(ID_NOUN).sort((a, b) => b.length - a.length).join("|");

/** The simulated agencies by their stored code, as people name them. */
export const AGENCY_WORDS: Record<string, string> = { irs: "IRS", ca_edd: "CA EDD", ny_dtf: "NY DTF", ny_dol: "NY DOL", tx_twc: "TX TWC", co_dor: "CO DOR", co_cdle: "CO CDLE" };
/** The IT systems by their stored code. */
export const SYSTEM_WORDS: Record<string, string> = { google_ws: "Google Workspace", chat: "chat", github: "GitHub", sso: "single sign-on" };
const AGENCY_RE = new RegExp(`\\b(${Object.keys(AGENCY_WORDS).join("|")})\\b`, "g");
/** Plural nouns a count of one reads in the singular ("Found 1 workers" is "Found 1 worker"). */
const SINGULAR: Record<string, string> = { workers: "worker", actions: "action", paychecks: "paycheck", results: "result", proposals: "proposal", requests: "request", expenses: "expense", notices: "notice", items: "item", people: "person", flags: "flag", tools: "tool" };

/** A delivered notice file ("CA_EDD_DE2088_2026.txt" from "ca_edd") named by its form: "the DE 2088 notice". */
function deliveredLine(file: string, agency: string): string {
  const stem = file.replace(/\.txt$/i, "").replace(new RegExp(`^${agency}_`, "i"), "").replace(/_\d{4}$/, "");
  const form = stem.replace(/_/g, " ").replace(/([A-Za-z])(\d)/g, "$1 $2").trim();
  const who = AGENCY_WORDS[agency] ? `${AGENCY_WORDS[agency]} (sim)` : agency;
  return form ? `Delivered the ${noticeName(form)} from ${who}` : `Delivered a notice from ${who}`;
}

/**
 * A tool's step line, a routine's summary or a proposal headline as copy. Times and dates read as on the payroll page,
 * a payroll run id reads as its payday ("the Oct 30 run"), parenthesized id lists and action numbers go, an id after
 * the noun it names goes, a bare id becomes its noun, a numbered draft reads "the reply", agency and system codes read
 * as names, and a count of one is singular. Ids of kinds not listed here stay as written.
 */
export function humanLine(text: string): string {
  // A file path keeps the ids it is named by ("entities/people/wrk_0026.md" is a path, not "the person").
  const paths: string[] = [];
  const kept = explanationsLine(text).replace(/\b[\w-]+(?:\/[\w.-]+)+\.(?:md|txt|json|csv)\b/g, (m) => `\u0002${paths.push(m) - 1}\u0002`);
  return humanLineBody(kept).replace(/\u0002(\d+)\u0002/g, (_m, i: string) => paths[Number(i)]!);
}

/**
 * The pre-payroll review's tally ("Explanations for pay_X: 0 agent, 4 template, 0 refused") as a sentence: "Explained 4
 * flagged paychecks on the Oct 30 run (from the rule templates)." Zero counts go; the counts are the tool's own.
 */
export function explanationsLine(text: string): string {
  return text.replace(/\bExplanations for (pay_\d{4}_\d{2}_\d{2}|the [A-Z][a-z]{2} \d{1,2} run): (\d+) agent, (\d+) template, (\d+) refused\b/g, (_m, run: string, a: string, b: string, c: string) => {
    const agent = Number(a); const tpl = Number(b); const refused = Number(c); const n = agent + tpl;
    const how = agent && tpl ? ` (${agent} by the agent, ${tpl} from the rule templates)` : tpl ? " (from the rule templates)" : "";
    const head = n ? `Explained ${n} flagged ${n === 1 ? "paycheck" : "paychecks"} on ${run}${how}` : `No flagged paychecks to explain on ${run}`;
    return refused ? `${head}; ${refused} could not be explained` : head;
  });
}

function humanLineBody(text: string): string {
  return humanDates(humanTimes(humanDateLists(text)))
    .replace(/\bDelivered (\S+\.txt) from ([a-z_]+) as [a-z]{2,5}_\w+/g, (_m, f: string, a: string) => deliveredLine(f, a))
    .replace(new RegExp(`\\s*\\((?:${ID}|#\\d+)(?:,\\s*(?:${ID}|#\\d+))*\\)`, "g"), "")
    .replace(/\b(?:(?:the|pay|payroll) )?(?:run )?pay_(\d{4})_(\d{2})_(\d{2})\b/g, (_m, y: string, mo: string, d: string) => `the ${fmtDate(`${y}-${mo}-${d}`)} run`)
    .replace(new RegExp(`\\b(${NAMED}) (?:${KNOWN})_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*\\b`, "g"), "$1")
    .replace(new RegExp(`\\b(?:the )?(${KNOWN})_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*\\b`, "g"), (_m, k: string) => ID_NOUN[k]!)
    .replace(/\bresponse \d+ (?:for|to) (?:the )?/g, "the reply to the ").replace(/\bresponse \d+\b/g, "the reply")
    .replace(/\bRecorded mention in\b/g, "Recorded a mention in")
    .replace(/\bAccepted offer: created (.+?) as onboarding\b/g, "Accepted the offer: added $1 to onboarding")
    .replace(/\bCreated (google_ws|chat|github|sso) account\b/g, (_m, k: string) => `Created ${SYSTEM_WORDS[k]} account`)
    .replace(AGENCY_RE, (k) => AGENCY_WORDS[k]!)
    .replace(/\b1 (workers|actions|paychecks|results|proposals|requests|expenses|notices|items|people|flags|tools)\b/g, (_m, w: string) => `1 ${SINGULAR[w]}`)
    .replace(/ {2,}/g, " ").replace(/ ([,.;:)])/g, "$1").replace(/;\s*;/g, ";").replace(/\(\s*\)/g, "").trim();
}

/** The first letter of a line in capitals ("the Oct 30 run draft" at the start of a step line). */
export const sentenceCase = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * A tool's step line in the agent panel and the run page: humanLine, a capital first letter, and the few engine
 * summaries that read as a log rewritten as a sentence ("Explanations for pay_X: 4 agent, 0 template, 0 refused" is
 * "Explained 4 flagged paychecks"; "1 actions for people.set_pay_rate" is "1 set pay rate action").
 */
export function stepLine(text: string): string {
  const t = text
    .replace(/^(\d+) actions? for ([a-z_]+\.[a-z_]+)/, (_m, n: string, cmd: string) => {
      const noun = COMMAND_NOUN[cmd];
      if (noun) return `Found ${n} ${n === "1" ? noun[0] : noun[1]}`;
      const verb = cmd.split(".")[1]!.replaceAll("_", " ");
      return `Found ${n} ${verb} ${n === "1" ? "action" : "actions"}`;
    })
    .replace(/^(\d+) actions?\b/, (_m, n: string) => `Found ${n} ${n === "1" ? "action" : "actions"}`)
    .replace(/^Read entities\/people\/wrk_[A-Za-z0-9_]+\.md$/, "Read the person's memory page");
  return sentenceCase(humanLine(t));
}

/** What an audit search by command found, as people name those changes. */
const COMMAND_NOUN: Record<string, [string, string]> = {
  "people.set_pay_rate": ["pay change", "pay changes"], "tax.update_rate": ["tax rate change", "tax rate changes"],
  "payroll.submit": ["payroll submission", "payroll submissions"], "time_off.decide": ["time-off decision", "time-off decisions"],
  "expenses.decide": ["expense decision", "expense decisions"], "people.update": ["profile change", "profile changes"],
};

/** A memory page read named by its page: "Read Lena Brooks (demo)'s memory page" for a person's page. */
export function memoryReadLine(path: string, body: string | null | undefined): string | null {
  const title = /^#\s+(.+)$/m.exec(body ?? "")?.[1]?.trim();
  if (!title) return null;
  return path.startsWith("entities/people/") ? `Read ${title}'s memory page` : `Read the memory page ${title}`;
}

/**
 * A routine run's summary as a short list in run order: "Proposed Update CA SUI ...; Proposed File ...; Drafted ..."
 * (the outcomes as the loop joined them, latest first) reads "Proposed: update the CA SUI rate ...; file the reply ...
 * Drafted the reply to the notice."
 */
export function routineSummaryText(text: string): string {
  const parts = humanLine(text).split(/;\s*|\n+/).map((p) => p.replace(/^-\s*/, "").trim()).filter(Boolean);
  if (parts.length < 2) return sentenceCase(parts[0] ?? "");
  const proposed: string[] = []; const did: string[] = [];
  for (const p of parts) {
    const m = /^Proposed:? (.+)$/.exec(p);
    if (m) proposed.push(m[1]![0]!.toLowerCase() + m[1]!.slice(1)); else did.push(sentenceCase(p));
  }
  const out: string[] = [];
  if (did.length) out.push(...did.reverse().map((d) => d.replace(/[.;]$/, "") + "."));
  if (proposed.length) out.push(`Proposed: ${proposed.reverse().map((p) => p.replace(/[.;]$/, "")).join("; ")}.`);
  return out.join(" ");
}

/** Engine rule and check codes in prose ("GROSS_CHANGE") as words ("gross change"). */
export function codeWords(text: string): string {
  return text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (c) => CODE_WORDS[c] ?? c.toLowerCase().replaceAll("_", " "));
}

/**
 * A chat answer as copy, at display only (the stored answer keeps the ids it cites, which graders and GP5 read): the
 * result ids it cites move out of the prose into `sources`, an id after a name goes, a pay run id reads as its payday,
 * rule codes read as words, "action 1" or "action sequence 1" reads as the audit label, and Markdown emphasis and code
 * marks go (the thread shows plain text).
 */
export function answerText(text: string): { text: string; sources: string[] } {
  const sources = [...new Set([...text.matchAll(/\bres_[A-Za-z0-9]+\b/g)].map((m) => m[0]))];
  const t = text
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)\*([^*\s][^*]*)\*(?=[\s.,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s*\(?\b(?:Sources?|Source result|Result ids?):?\s*(?:(?:result\s+)?(?:res|tor|prp|act)_[A-Za-z0-9]+(?:,?\s*(?:and\s+)?)?)+\)?\.?/gi, (m) => (/res_|tor_|prp_|act_/.test(m) ? "" : m))
    .replace(/,?\s*\b(?:result|results)\s+res_[A-Za-z0-9]+(?:(?:,\s*|\s+and\s+)res_[A-Za-z0-9]+)*/g, "")
    .replace(/\s*\(res_[A-Za-z0-9]+(?:,\s*res_[A-Za-z0-9]+)*\)/g, "")
    .replace(/\bres_[A-Za-z0-9]+\b/g, "")
    .replace(/\b(?:recorded by |in |by )?action (?:sequence |seq\.? |#)?(\d+)\b/g, (m, n: string) => `${m.startsWith("recorded by") ? "recorded as " : m.startsWith("in ") ? "in " : m.startsWith("by ") ? "by " : ""}${auditLabel(Number(n))}`);
  const out = codeWords(humanLine(t))
    .replace(/,\s*,/g, ",").replace(/,\s*\./g, ".").replace(/\.\s*\./g, ".").replace(/\s+([.,;:])/g, "$1").replace(/:\s*\./g, ".")
    .replace(/[ \t]{2,}/g, " ").trim();
  return { text: out, sources };
}

/**
 * A clamped preview of an answer (the Recent answers list): the answer as copy on one line. A line clamp adds its
 * own ellipsis, so the text's last period goes and "tool." never reads "tool....".
 */
export function previewText(text: string): string {
  return answerText(text).text.replace(/\s+/g, " ").trim().replace(/\.$/, "");
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

/** Stored status values as people read them in a before and after row. */
const STATUS_WORDS: Record<string, string> = {
  draft: "Draft", processing: "Submitted for processing", in_review: "In review", resolved: "Resolved", new: "New", none: "None",
  needs_review: "Needs review", approved_taxable: "Approved, taxable", not_paid: "Not paid",
};
/**
 * A proposal diff value as copy: a lone enum value is a capitalized word ("in_review" is "In review"), "draft to
 * processing" reads "Draft → Submitted for processing", and other text reads as humanLine does (ids, dates, pay runs).
 */
export function valueText(v: string): string {
  const t = humanTimes(v).trim();
  if (/^[a-z]+(?:_[a-z0-9]+)*$/.test(t)) return STATUS_WORDS[t] ?? statusLabel(t);
  const m = /^([a-z]+(?:_[a-z]+)*) (?:to|->|→) ([a-z]+(?:_[a-z]+)*)$/.exec(t);
  if (m) return `${valueText(m[1]!)} → ${valueText(m[2]!)}`;
  // The approval card's executor joins a row as "before to after": "Not scheduled to not_paid" is two values.
  const j = /^(not scheduled|pay_\d{4}_\d{2}_\d{2}|[a-z]+(?:_[a-z0-9]+)+) to (.+)$/.exec(t);
  if (j) return `${valueText(j[1]!)} → ${valueText(j[2]!)}`;
  return sentenceCase(enumWords(humanLine(t)));
}

export type Severity = "block" | "review" | "info";
export interface PolicyCheck { rule: string; severity: Severity | null; message: string }
/**
 * Policy and coverage checks travel in a proposal's diff as "Check RULE" rows (the severity in Before) or "Check RULE
 * (severity)" rows; they read as a list of checks with a severity badge, not as before and after values.
 */
export function splitChecks<R extends { label: string; before: string; after: string }>(diff: R[]): { rows: R[]; checks: PolicyCheck[] } {
  const rows: R[] = []; const checks: PolicyCheck[] = [];
  for (const r of diff) {
    const m = /^Check ([A-Z][A-Z0-9_]*)(?: \((block|review|info)\))?$/.exec(r.label);
    if (!m) { rows.push(r); continue; }
    const sev = (m[2] ?? r.before) as string;
    checks.push({ rule: m[1]!, severity: sev === "block" || sev === "review" || sev === "info" ? sev : null, message: humanCopy(r.after) });
  }
  return { rows, checks };
}

/**
 * An approval card's field (the executor joins a diff row as "before to after"): a policy check row ("Check
 * MEALS_DETAIL_MISSING", "review to Meals need ...") reads "Policy check, meals detail missing" with its message.
 */
export function cardField(label: string, value: string): { label: string; value: string } {
  const m = /^Check ([A-Z][A-Z0-9_]*)(?: \((?:block|review|info)\))?$/.exec(label);
  if (m) return { label: `Policy check, ${(RULE_WORDS[m[1]!] ?? codeWords(m[1]!)).toLowerCase()}`, value: humanCopy(value.replace(/^(?:block|review|info) to /, "")) };
  return { label: humanLine(label), value: valueText(value) };
}
