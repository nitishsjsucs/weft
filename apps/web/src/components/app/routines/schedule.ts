// A routine's trigger as words, wherever a page shows it: the gallery cards, the All routines table and the routine
// page. Raw cron and event keys never show; the stored trigger is the title where a page wants it.
import type { RoutineDef } from "@weft/contracts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** What each routine event means, as the start of a sentence. */
export const EVENT_WORDS: Record<string, string> = {
  "notice.received": "When an agency notice arrives",
  "notice.uploaded": "When someone uploads a notice",
  "offer.accepted": "When a candidate accepts an offer",
  "offer.imported": "When an offer arrives from the applicant tracker",
  "time_off.request.created": "When someone requests time off",
  "worker.created": "When a person is added",
  "enrollment_window.closed": "When a benefits enrollment window closes",
  "payroll.draft_created": "When a payroll draft is created",
  "payroll.processed": "When a payroll is processed",
  "integration.ats_hire_detected": "When the applicant tracker reports a hire",
  "tax_account.activated": "When a state tax account is activated",
};
const tzWord = (tz: string) => (tz === "America/Los_Angeles" ? "PT" : tz === "America/New_York" ? "ET" : tz);
const clock = (h: number, m: number) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "0 9 * * 1-5" in America/Los_Angeles is "Weekdays at 9:00 AM PT"; "5 * * * *" is "Every hour at :05". */
export function cronWords(cron: string, tz: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return "Custom schedule";
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const m = Number(min); const h = Number(hour);
  if (!/^\d+$/.test(min) || m > 59) return "Custom schedule";
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every hour at :${String(m).padStart(2, "0")}`;
  if (!/^\d+$/.test(hour) || h > 23 || mon !== "*") return "Custom schedule";
  const at = `${clock(h, m)} ${tzWord(tz)}`;
  if (/^\d+$/.test(dom) && dow === "*") return `Monthly on the ${ordinal(Number(dom))}, ${at}`;
  if (dom !== "*") return "Custom schedule";
  if (dow === "*") return `Every day at ${at}`;
  if (dow === "1-5") return `Weekdays at ${at}`;
  if (/^\d(,\d)*$/.test(dow)) {
    const ds = dow.split(",").map((d) => DAYS[Number(d) % 7]);
    if (ds.some((d) => !d)) return "Custom schedule";
    return `${list(ds.map((d) => `${d}s`))} at ${at}`;
  }
  return "Custom schedule";
}

/** Readable trigger: "Mondays at 9:00 AM PT", "When an agency notice arrives", "Manual". */
export function triggerLabel(t: RoutineDef["trigger"]): string {
  if (t.type === "manual") return "Manual";
  if (t.type === "event") return EVENT_WORDS[t.event] ?? `When ${t.event.replace(/[._]/g, " ")} happens`;
  return cronWords(t.cron, t.tz);
}

/** The gallery API's schedule line ("cron 0 9 * * 1 (America/Los_Angeles)", "on notice.received") as words. */
export function scheduleWords(s: string): string {
  const cron = /^cron (.+?) \(([^)]+)\)$/.exec(s.trim()) ?? /^(\S+ \S+ \S+ \S+ \S+) \(([^)]+)\)$/.exec(s.trim());
  if (cron) return cronWords(cron[1]!, cron[2]!);
  const bare = /^cron (\S+ \S+ \S+ \S+ \S+)$/.exec(s.trim());
  if (bare) return cronWords(bare[1]!, "America/Los_Angeles");
  const ev = /^on (\S+)$/i.exec(s.trim());
  if (ev) return EVENT_WORDS[ev[1]!] ?? `When ${ev[1]!.replace(/[._]/g, " ")} happens`;
  return /^manual$/i.test(s.trim()) ? "Manual" : s;
}
