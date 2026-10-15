// Deterministic P0 parser for create-your-own routines (SPEC 9.7). "Every Friday, post open approvals to #payroll"
// gives cron 0 9 * * 5 in America/Los_Angeles, the channel from the closed enum, the "open approvals" template and the
// tools [comms.send_message]. Anything it cannot resolve returns { ok: false } so the caller can ask, or (only with
// WEFT_LLM=openai) start an attended routine_draft run.
import { Cron } from "croner";
import { ChatChannel } from "@weft/contracts";

export const DRAFT_TZ = "America/Los_Angeles";
const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAY_RE = /\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?\b/gi;

export type DraftTemplate = "open_approvals";

export interface ParsedDraft {
  ok: true;
  name: string;
  cron: string;
  tz: string;
  channel: ChatChannel;
  template: DraftTemplate;
  precheck: "open_approvals";
  tools: ["comms.send_message"];
  instructions: string;
}
export type DraftParse = ParsedDraft | { ok: false; reason: string; hint: string };

function dayIndex(token: string): number | null {
  const t = token.toLowerCase();
  for (const [name, i] of Object.entries(DAYS)) if (name.startsWith(t.slice(0, 3))) return i;
  return null;
}

/** "9", "9am", "9:30 am", "14:00", "noon". Default 09:00. */
function parseTime(text: string): { h: number; m: number } | null | "invalid" {
  const t = text.toLowerCase();
  if (/\bnoon\b/.test(t)) return { h: 12, m: 0 };
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\W|$)/.exec(t.replace(/#\S+/g, " "));
  if (!m || (!m[3] && !m[2] && !/\bat\s+\d/.test(t))) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return "invalid";
  return { h, m: min };
}

export function validateCron(cron: string, tz = DRAFT_TZ): { ok: true } | { ok: false; message: string } {
  try {
    new Cron(cron, { timezone: tz, paused: true }).stop();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function parseRoutineDraft(prompt: string): DraftParse {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  let dow: string;
  if (/\b(every day|daily|each day)\b/.test(lower)) dow = "*";
  else if (/\b(weekdays?|every weekday|business days?)\b/.test(lower)) dow = "1-5";
  else {
    const days = [...new Set([...text.matchAll(DAY_RE)].map((m) => dayIndex(m[1]!)).filter((d): d is number => d !== null))].sort();
    if (!days.length) return { ok: false, reason: "NO_SCHEDULE", hint: "Name a weekday or say every day, for example: Every Friday, post open approvals to #payroll" };
    dow = days.join(",");
  }
  const time = parseTime(text);
  if (time === "invalid") return { ok: false, reason: "BAD_TIME", hint: "Use a time like 9am or 14:30." };
  const { h, m } = time ?? { h: 9, m: 0 };
  const channelMatch = /#[a-z0-9-]+/i.exec(text)?.[0]?.toLowerCase();
  const parsedChannel = ChatChannel.safeParse(channelMatch ?? "#people-ops");
  if (!parsedChannel.success) return { ok: false, reason: "UNKNOWN_CHANNEL", hint: `Pick one of ${ChatChannel.options.join(", ")}.` };
  if (!/\b(open|pending)\s+(approvals?|proposals?|items?)\b|\bapprovals?\b/.test(lower)) {
    return { ok: false, reason: "UNKNOWN_TEMPLATE", hint: "P0 routines can post open approvals; for example: Every Friday, post open approvals to #payroll" };
  }
  const cron = `${m} ${h} * * ${dow}`;
  const v = validateCron(cron);
  if (!v.ok) return { ok: false, reason: "BAD_CRON", hint: v.message };
  const dayWords = dow === "*" ? "Every day" : dow === "1-5" ? "Weekdays" : `Every ${dow.split(",").map((d) => Object.keys(DAYS)[Number(d)]!).map((d) => d[0]!.toUpperCase() + d.slice(1)).join(" and ")}`;
  return {
    ok: true,
    name: `${dayWords}: open approvals to ${parsedChannel.data}`,
    cron, tz: DRAFT_TZ, channel: parsedChannel.data, template: "open_approvals", precheck: "open_approvals", tools: ["comms.send_message"],
    instructions: `Post the count of open approvals and their headlines to ${parsedChannel.data}. Counts come from the precheck.`,
  };
}
