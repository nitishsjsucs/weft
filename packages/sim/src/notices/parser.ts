// Deterministic notice parser (SPEC 8): labeled lines in, typed fields out. No model, no heuristics beyond the
// labels the simulator itself prints. Output is NoticeExtract; taxAccountId is matched later by the domain.
import type { AgencyCode, AgencyNoticeKind, EmployerRateCode, NoticeExtract } from "@weft/contracts";

/** "1.5" (percent) to "0.015" (decimal string), exact, without floats. */
export function percentToRate(pct: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(pct.trim());
  if (!m) throw new Error(`percentToRate: ${pct}`);
  const i = m[1]!, f = m[2] ?? "";
  const digits = (i + f).replace(/^0+/, "") || "0";
  const scale = f.length + 2;
  const s = digits.padStart(scale + 1, "0");
  const r = `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
  return r.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

const MONTHS: Record<string, string> = { January: "01", February: "02", March: "03", April: "04", May: "05", June: "06", July: "07", August: "08", September: "09", October: "10", November: "11", December: "12" };

/** Accepts YYYY-MM-DD or "January 1, 2026". */
export function parseDate(s: string): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(t);
  if (m && MONTHS[m[1]!]) return `${m[3]}-${MONTHS[m[1]!]}-${m[2]!.padStart(2, "0")}`;
  throw new Error(`parseDate: ${s}`);
}

function field(text: string, label: string): string | null {
  const re = new RegExp(`^\\s*${label.replace(/[()]/g, "\\$&")}:\\s*(.+?)\\s*$`, "m");
  return re.exec(text)?.[1] ?? null;
}

const RATE_LINES: { label: string; code: EmployerRateCode }[] = [
  { label: "Unemployment Insurance (UI)", code: "sui" },
  { label: "Employment Training Tax (ETT)", code: "ett" },
];

/** Changed employer rates only: "1.5% (previously 3.4%)" yields one entry; "(unchanged)" yields none. */
function parseRates(text: string): NoticeExtract["rates"] {
  const out: NoticeExtract["rates"] = [];
  for (const { label, code } of RATE_LINES) {
    const v = field(text, label);
    if (!v) continue;
    const m = /^(\d+(?:\.\d+)?)% \(previously (\d+(?:\.\d+)?)%\)$/.exec(v);
    if (m) out.push({ code, newRate: percentToRate(m[1]!), oldRate: percentToRate(m[2]!) });
  }
  return out;
}

export interface ParseInput { agency: AgencyCode; formCode: string; kind: AgencyNoticeKind; text: string }

export function parseNotice({ agency, formCode, kind, text }: ParseInput): NoticeExtract {
  const account = field(text, "Employer Account Number") ?? field(text, "Withholding ID") ?? field(text, "EIN");
  const year = field(text, "Rate Year") ?? field(text, "Tax Year");
  const eff = field(text, "Effective Date");
  const respond = field(text, "Respond By");
  return {
    agency, formCode, kind,
    accountNumber: account,
    taxAccountId: null,
    taxYear: year ? Number(year) : null,
    effectiveFrom: eff ? parseDate(eff) : null,
    respondBy: respond ? parseDate(respond) : null,
    rates: parseRates(text),
    amountCents: null,
    period: field(text, "Period") ?? field(text, "New Schedule"),
  };
}
