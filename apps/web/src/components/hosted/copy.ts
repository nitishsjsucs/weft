// Every line the hosted shell shows (docs/cloudflare/design.md 6.2 and 6.5), pure so the unit tests read them. Owner:
// cf5-web. No React here. Since 2026-10-23 only two people use the hosted app, so it reads as a workspace and names
// no session times or counts.
import type { DegradationLevel, LeaseResult, SessionStatus } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { WORKERS_AI_LABEL, type HostedProviderId } from "../../../../../packages/contracts/src/ext/cf-agent";

export const HOSTED_COPY = {
  showcase: "You are looking at a shared, read-only workspace.",
  showcaseCta: "Open my workspace",
  showcaseMore: "Your own workspace has the live agent.",
  startTitle: "Open my workspace",
  startBody: "Weft gives you your own copy of Larkspur Robotics with the live agent.",
  startForMutation: "The shared workspace is read only. Open your own to make changes.",
  startCheck: "A quick check that you are a person comes first.",
  starting: "Starting your workspace...",
  checkFailed: "The check did not pass. Try again.",
  tryAgain: "Try again",
  keepBrowsing: "Keep browsing the shared workspace",
  grantTitle: "One quick check",
  grantBody: "Changes need a fresh check that you are a person. It usually passes on its own.",
  grantCancel: "Cancel",
  endedTitle: "Your workspace has ended",
  endedExpired: "Weft closed it after a long time without activity. A new workspace starts from fresh data.",
  endedServer: "Weft closed this workspace and reset its data.",
  endedAgain: "Open a new workspace",
  endedBrowse: "Browse the shared workspace",
  requestCap: "Weft has used today's shared request allowance. Pages still load; data comes back after 00:00 UTC.",
  apiDown: "Weft's API is not answering right now. Pages still load; try again in a minute.",
  rateLimited: "Too many requests from this network for a moment. Pages still load; try again in a minute.",
  demoLimit: "This workspace has used its activity limit. Reset it from Viewing as to start fresh.",
  showcaseLimit: "The shared workspace has hit its daily limit. Open your own workspace, or come back after 00:00 UTC.",
} as const;

/** " One frees in about 7 min." A lease can last 30 days, so a long wait reads in hours, then in days. */
function etaLine(etaMinutes: number | null): string {
  if (etaMinutes === null) return "";
  const min = Math.max(1, Math.round(etaMinutes));
  if (min < 90) return ` One frees in about ${min} min.`;
  if (min < 48 * 60) return ` One frees in about ${Math.round(min / 60)} hours.`;
  return ` One frees in about ${Math.round(min / 1_440)} days.`;
}

/** The line for a lease attempt that did not lease. */
export function blockedText(r: Exclude<LeaseResult, { status: "leased" }>): string {
  switch (r.status) {
    case "waitlist": return `All ${r.poolSize} workspaces are in use.${etaLine(r.etaMinutes)} You are number ${r.position} in line.`;
    case "full": return `All ${r.poolSize} workspaces are in use and the line is full.${etaLine(r.etaMinutes)} Try again later.`;
    case "budget": return "Today's budget is used up; back after 00:00 UTC.";
    case "ip_limit": return "This network has opened as many workspaces as it can today; back after 00:00 UTC.";
    case "closed": return "New workspaces are paused for today to stay inside the shared daily limits. The shared workspace stays open.";
  }
}

/** Why new runs use the scripted provider, or null when they do not. */
export function providerNote(p: SessionStatus["provider"], agentEnabled: boolean): string | null {
  if (!agentEnabled || p.reason === "paused") return "The agent is paused for now. New runs use the scripted provider.";
  if (p.reason === "budget") return "Today's budget is used up, so new agent runs use the scripted provider until 00:00 UTC.";
  if (p.reason === "neurons") return "Today's Workers AI allowance is used up, so new agent runs use the scripted provider until 00:00 UTC.";
  return null;
}

/** The badge for a provider id. */
export function providerLabel(id: HostedProviderId | null): string {
  if (id === null) return "Default";
  if (id === "workers_ai") return WORKERS_AI_LABEL;
  if (id === "openai") return "OpenAI gpt-5.6-luna";
  if (id === "scripted") return "Scripted, no model calls";
  return id;
}

/** A sentence for each degradation level (design 6.5). */
export function levelText(level: DegradationLevel): string {
  switch (level) {
    case 0: return "Normal.";
    case 1: return "Over 70% of a daily share: pages refresh less often and mostly from the live feed.";
    case 2: return "The day's dollar or neuron cap, or the kill switch: new runs use the scripted provider.";
    case 3: return "Over 90% of the Durable Object rows or requests share: no new workspaces today; the shared workspace stays open.";
    case 4: return "The account's Workers request cap: only static pages load until 00:00 UTC.";
  }
}

/**
 * The hosted line in the "Reset workspace data..." dialog: what a reset does here. It names no count: a lease allows
 * HOSTED_SETTINGS.resetsPerLease resets (1,000 since 2026-10-23), which two people never reach, so the lease's
 * `resetsLeft` the tour passes is not shown.
 */
export function resetNote(_resetsLeft?: number | null): string {
  return "Here a reset rebuilds your own workspace, with the rich data only.";
}

/** The reset error line for the hosted gate codes; null leaves the tour's own wording. */
export function hostedResetError(status: number | null, code: string | null): string | null {
  if (code === "RESETS_PAUSED") return "Weft has used most of today's free Cloudflare quota, so resets are paused until 00:00 UTC. Your workspace keeps working.";
  if (code === "RESET_LIMIT" || status === 429) return "This workspace has used all of its resets.";
  if (code === "HOSTED_RESET_PROFILE") return "Here a reset uses the rich data only.";
  if (code === "LEASE_REQUIRED") return "Open your own workspace first; the shared one cannot be reset.";
  return null;
}

/** "$0.0123" under a cent, else "$1.23". */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
export function usdMicros(micros: number): string { return usd(micros / 1_000_000); }
