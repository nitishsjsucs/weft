// The Inbox's deep link (/app/inbox?proposal=prp_...), as plain functions the view calls and the unit suite runs.
import type { Proposal } from "@weft/contracts";

/** The tab that holds a proposal. */
export const tabOf = (p: Pick<Proposal, "status" | "kind">): string => (p.status !== "pending" ? "decided" : p.kind === "suggestion" ? "suggestions" : "pending");

/**
 * The list the Inbox shows: its page of proposals (the lowest ids first), and the proposal the link names when that
 * page does not hold it (fetched on its own: one a handoff just filed is often past the page).
 */
export function inboxRows(list: readonly Proposal[] | undefined, target: string | null, fetched: Proposal | undefined): { rows: Proposal[] | undefined; linked: Proposal | undefined } {
  const listed = target ? list?.find((p) => p.id === target) : undefined;
  const linked = listed ?? (target && fetched?.id === target ? fetched : undefined);
  return { rows: list && linked && !listed ? [...list, linked] : list ? [...list] : undefined, linked };
}

/** The tab a link opened for its proposal: kept while the link names it with no tab, decided once when it is loaded. */
export interface LinkTab { target: string; tab: string }

/**
 * The tab a link with no tab key opens: the one that held the proposal when the link named it. A tab in the link
 * (the person's pick, written out while a proposal is named) clears it, so a later link to the same proposal opens its
 * tab again; the proposal moving tab after a decision does not move the page.
 */
export function nextLinkTab(prev: LinkTab | null, tabParam: string | null, target: string | null, linked: Pick<Proposal, "status" | "kind"> | undefined): LinkTab | null {
  if (tabParam !== null || !target) return null;
  if (prev?.target === target) return prev;
  return linked ? { target, tab: tabOf(linked) } : null;
}

/** The tab key a pick writes: Approvals is the default and leaves the key out, unless a proposal is named. */
export const tabParamFor = (v: string, target: string | null): string | null => (v === "pending" && !target ? null : v);
