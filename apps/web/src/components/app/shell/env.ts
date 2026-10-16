// Pure helpers for the top bar's environment pill (research/wave3/topbar-design.md 5.3 to 5.7). Owner: w3-topbar-shell.
// No React here, so the unit tests can read every label the bar shows.
import { W3_TOPBAR_SHELL_TIERS } from "@weft/contracts";

/** Model status as the bar shows it: the dot color and the Mode row of the model popover come from this. */
export type ModelState = "live" | "local" | "scripted" | "offline" | "loading";

export interface ProviderInfo { id: string; model: string; label: string; live: boolean }

/**
 * Hosted live models (OpenAI, Claude) are metered; local OpenAI-compatible models carry a "Local ..." label and are
 * free; the scripted provider is not live at all.
 */
export function modelState(provider: ProviderInfo | undefined, failed: boolean): ModelState {
  if (!provider) return failed ? "offline" : "loading";
  if (!provider.live) return "scripted";
  return /^local\b/i.test(provider.label) || provider.id === "local" ? "local" : "live";
}

export const MODE_LABEL: Record<ModelState, string> = {
  live: "Live, metered",
  local: "Local, unmetered",
  scripted: "Scripted, no model calls",
  offline: "API offline",
  loading: "Checking",
};

/** Label for the model segment: the full provider label in Full, the bare model id in Compact. */
export function modelLabel(provider: ProviderInfo | undefined, state: ModelState, tier: "full" | "compact"): string {
  if (state === "offline") return "API offline";
  if (!provider) return "";
  if (state === "scripted") return "Scripted";
  return tier === "full" ? provider.label : provider.model || provider.label;
}

/** Accessible name for the model segment; carries the meaning that narrow tiers drop from the visible text. */
export function modelAria(provider: ProviderInfo | undefined, state: ModelState): string {
  if (state === "offline") return "Model: API offline";
  if (state === "loading" || !provider) return "Model: checking";
  const how = state === "live" ? "live and metered" : state === "local" ? "live, local and unmetered" : "scripted, no model calls";
  return `Model: ${provider.label}, ${how}`;
}

/** Spend for the model popover: cents precision, or four decimals under a cent so a small live call still shows. */
export function fmtUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const TZ = "America/Los_Angeles";

/** "Monday, October 26, 8:30 AM PT" for the clock popover title row. */
export function fmtLongClock(iso: string): string {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return `${s.replace(" at ", ", ")} PT`;
}

/** "Simulated time: Monday, October 26, 8:30 AM Pacific" */
export function clockAria(iso: string | undefined): string {
  return iso ? `Simulated time: ${fmtLongClock(iso).replace(/ PT$/, " Pacific")}` : "Simulated time: loading";
}

/** Clock rate for the popover: 0 is paused, 1 is real time, anything else is a multiplier. */
export function rateLabel(rate: number | undefined): string {
  if (rate === undefined) return "";
  if (rate === 0) return "Paused";
  if (rate === 1) return "Real time";
  return `${rate}x`;
}

const weekdayHourPt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Next prebuilt routine slot (09:00 PT on a weekday) strictly after `now`; the same rule the API applies to
 * `POST /v1/sim/clock/advance { toNext: "cron" }`, so the popover row and the button agree.
 */
export function nextRoutineSlot(now: string): string | null {
  let t = Math.floor(Date.parse(now) / 60_000) * 60_000 + 60_000;
  if (Number.isNaN(t)) return null;
  // Step a minute at a time until 09:00 on a weekday; jump by an hour while far from it.
  for (let i = 0; i < 24 * 60 * 8; i++) {
    const parts = Object.fromEntries(weekdayHourPt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    if (parts.weekday !== "Sat" && parts.weekday !== "Sun" && parts.hour === "09" && parts.minute === "00") return new Date(t).toISOString();
    t += 60_000;
  }
  return null;
}

/** "DW" from "Dana Whitfield (demo)": first letters of the first two words, ignoring the "(demo)" marker. */
export function initials(name: string): string {
  const words = name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export function firstName(name: string): string {
  return name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/)[0] ?? name;
}

/** Persona groups in the Viewing as menu, in order. Every admin-type role reads as an admin. */
export type PersonaGroup = "Admins" | "Managers" | "Employees";
const ROLE_GROUP: Record<string, PersonaGroup> = { admin: "Admins", payroll_admin: "Admins", hr_manager: "Admins", manager: "Managers", employee: "Employees" };
const GROUP_ORDER: PersonaGroup[] = ["Admins", "Managers", "Employees"];

/** Role in sentence case for the second line of a persona row: "payroll_admin" reads "payroll admin". */
export function roleLabel(role: string): string {
  return role === "hr_manager" ? "HR manager" : role.replace(/_/g, " ");
}

export interface Persona { id: string; name: string; title: string; role: string }

/** Groups personas by role, keeping their order inside a group and dropping empty groups. */
export function groupPersonas<P extends Persona>(people: readonly P[]): { group: PersonaGroup; people: P[] }[] {
  return GROUP_ORDER
    .map((group) => ({ group, people: people.filter((p) => (ROLE_GROUP[p.role] ?? "Employees") === group) }))
    .filter((g) => g.people.length > 0);
}

/** The header's three width tiers (by the header's own container width, not the window). */
export const TIER_FULL_MIN = W3_TOPBAR_SHELL_TIERS.fullMin;
export const TIER_COMPACT_MIN = W3_TOPBAR_SHELL_TIERS.compactMin;
export function tierFor(width: number): "full" | "compact" | "mini" {
  return width >= TIER_FULL_MIN ? "full" : width >= TIER_COMPACT_MIN ? "compact" : "mini";
}
