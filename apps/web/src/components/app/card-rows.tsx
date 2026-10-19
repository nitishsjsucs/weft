// How a proposal's before and after read on a narrow card (the agent panel's approval card, the Inbox card on a phone).
import type { ReactNode } from "react";

const UNPAID = /^(?:not scheduled|not paid|none|unpaid)$/i;

/** A row whose before and after both mean "no pay" (a returned or declined expense that was never scheduled) says
 * nothing changes, so the card leaves it out. */
export function idleMoneyRow(before: string, after: string): boolean {
  return UNPAID.test(before.trim()) && UNPAID.test(after.trim());
}

/** "$356.01 to $157.06" as two unbreakable halves, so a wrap falls only before "to $157.06", never around the "to". */
export function splitChange(value: string): [string, string] | null {
  const m = /^(\S(?:.*\S)?) (to|→) (\S(?:.*\S)?)$/.exec(value);
  if (!m || m[1]!.length > 28 || m[3]!.length > 28 || / to | → /.test(m[1]!)) return null;
  return [m[1]!, `${m[2]} ${m[3]}`];
}

export function ChangeValue({ value }: { value: string }): ReactNode {
  const parts = splitChange(value);
  if (!parts) return value;
  return <><span className="whitespace-nowrap">{parts[0]}</span> <span className="whitespace-nowrap">{parts[1]}</span></>;
}
