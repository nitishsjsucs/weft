// Life-event special enrollment rules (wave 4, T6). Owner: w4-parity-people.
// Each qualifying event opens one special enrollment window of LIFE_EVENT_WINDOW_DAYS (30) days from the event date.
// Two federal rules set the floor, and the plan rule for Larkspur Robotics (demo) uses 30 days for every kind:
// - HIPAA special enrollment (29 CFR 2590.701-6): marriage, birth, adoption or placement for adoption, and loss of
//   other coverage give at least 30 days after the event to enroll in the group health plan.
// - Section 125 change in status (26 CFR 1.125-4(c)): divorce, a dependent's death and a change of residence let a
//   cafeteria plan accept a consistent mid-year election change; the plan sets the window, here the same 30 days.
// The source travels with every window this code opens (lifeEventRule(kind).source), so the agent never states a rule
// it did not read.
import { LIFE_EVENT_WINDOW_DAYS, type LifeEventKind } from "@weft/contracts";

export type WindowBasis = "hipaa_special_enrollment" | "section_125_change_in_status";
export interface LifeEventRule { kind: LifeEventKind; label: string; days: number; basis: WindowBasis; citation: string; source: string }

const HIPAA = { basis: "hipaa_special_enrollment" as const, citation: "29 CFR 2590.701-6", source: "https://www.ecfr.gov/current/title-29/section-2590.701-6" };
const S125 = { basis: "section_125_change_in_status" as const, citation: "26 CFR 1.125-4(c)", source: "https://www.ecfr.gov/current/title-26/section-1.125-4" };

export const LIFE_EVENT_RULES: Record<LifeEventKind, LifeEventRule> = {
  marriage: { kind: "marriage", label: "Marriage", days: LIFE_EVENT_WINDOW_DAYS, ...HIPAA },
  birth: { kind: "birth", label: "Birth of a child", days: LIFE_EVENT_WINDOW_DAYS, ...HIPAA },
  adoption: { kind: "adoption", label: "Adoption or placement for adoption", days: LIFE_EVENT_WINDOW_DAYS, ...HIPAA },
  loss_of_coverage: { kind: "loss_of_coverage", label: "Loss of other coverage", days: LIFE_EVENT_WINDOW_DAYS, ...HIPAA },
  divorce: { kind: "divorce", label: "Divorce or legal separation", days: LIFE_EVENT_WINDOW_DAYS, ...S125 },
  death_of_dependent: { kind: "death_of_dependent", label: "Death of a dependent", days: LIFE_EVENT_WINDOW_DAYS, ...S125 },
  move: { kind: "move", label: "Move to a new home address", days: LIFE_EVENT_WINDOW_DAYS, ...S125 },
};

export const lifeEventRule = (kind: LifeEventKind): LifeEventRule => LIFE_EVENT_RULES[kind];

/** YYYY-MM-DD plus n days (calendar days, noon UTC so no zone shifts the date). */
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00.000Z`) - Date.parse(`${a}T12:00:00.000Z`)) / 86_400_000);

/** The window a qualifying event opens: from the event date through event date plus the rule's days. */
export function windowFor(kind: LifeEventKind, eventDate: string): { opensOn: string; closesOn: string; days: number } {
  const r = lifeEventRule(kind);
  return { opensOn: eventDate, closesOn: addDays(eventDate, r.days), days: r.days };
}

/**
 * Reminder dates for a window: 14, 7 and 2 days before it closes, keeping only those after the day it was reported.
 * remindersSent counts the dates already passed when a reminder went out, so a missed run never sends a burst.
 */
export const REMINDER_DAYS_BEFORE_CLOSE = [14, 7, 2] as const;
export function reminderDates(closesOn: string, reportedOn: string): string[] {
  return REMINDER_DAYS_BEFORE_CLOSE.map((n) => addDays(closesOn, -n)).filter((d) => d > reportedOn);
}
