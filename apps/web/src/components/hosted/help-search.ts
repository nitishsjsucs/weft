// Help results in Cmd+K (docs/cloudflare/design.md 7.1): AI Search over Weft's own docs, capped at 30 queries a day
// for all of hosted Weft, so the menu searches only when the visitor picks "Search Weft help" (never on each keystroke).
import { HOSTED_PATHS, HOSTED_SETTINGS } from "../../../../../packages/contracts/src/ext/cf-hosted";
import type { HelpSearchResult } from "../../../../../packages/contracts/src/ext/cf-extras";
import { apiFetch } from "@/lib/api/client";

/** Queries shorter than this stay local (pages, people, payroll runs). */
export const HELP_MIN_CHARS = 3;

export function helpPath(q: string): string {
  return `${HOSTED_PATHS.help}?q=${encodeURIComponent(q.trim())}`;
}

/** GET /api/_hosted/help?q=. Errors come back as a HelpSearchResult-shaped refusal. */
export async function searchHelp(q: string, f: typeof fetch = apiFetch): Promise<HelpSearchResult> {
  try {
    const res = await f(helpPath(q), { headers: { accept: "application/json" } });
    const j = (await res.json().catch(() => null)) as (HelpSearchResult & { message?: string }) | null;
    if (res.ok && j && typeof j.ok === "boolean") return j;
    return { ok: false, code: res.status === 429 ? "HELP_DAILY_CAP" : "HELP_DISABLED", message: j?.message ?? `Help search is not available right now (${res.status}).` };
  } catch {
    return { ok: false, code: "HELP_DISABLED", message: "Help search is not available right now." };
  }
}

/** The menu's line for a result: hits, the cap, or why there are none. */
export function helpSummary(r: HelpSearchResult): string {
  if (!r.ok) return r.code === "HELP_DAILY_CAP" ? `Help search has used its ${HOSTED_SETTINGS.helpQueriesPerDay} searches for today; back after 00:00 UTC.` : r.message;
  if (!r.hits.length) return `No help pages match. ${r.leftToday} ${r.leftToday === 1 ? "search" : "searches"} left today.`;
  return `${r.hits.length} help ${r.hits.length === 1 ? "page" : "pages"}. ${r.leftToday} ${r.leftToday === 1 ? "search" : "searches"} left today.`;
}
