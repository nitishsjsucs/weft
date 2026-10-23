// Every line the hosted shell shows (docs/cloudflare/design.md 6.2 and 6.5), pure so the unit tests read them. Owner:
// cf5-web. No React here.
import type { DegradationLevel, LeaseResult, SessionStatus } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { HOSTED_SETTINGS } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { WORKERS_AI_LABEL, type HostedProviderId } from "../../../../../packages/contracts/src/ext/cf-agent";

export const HOSTED_COPY = {
  showcase: "You are looking at a shared demo company. It is read only, and every visitor sees the same one.",
  showcaseCta: "Start my demo company",
  showcaseMore: "Your own copy has the live agent and resets for the next visitor when you are done.",
  fictional: "Everything here is fictional. Please do not type real personal data.",
  startTitle: "Start my demo company",
  startBody: `Weft gives you your own copy of Larkspur Robotics (demo) with the live agent. It lasts up to ${HOSTED_SETTINGS.leaseTotalMinutes / 60} hours, or ${HOSTED_SETTINGS.leaseIdleMinutes} minutes without activity, then resets for the next visitor.`,
  startForMutation: "The shared demo company is read only. Start your own to make changes.",
  startCheck: "A quick check that you are a person comes first.",
  starting: "Starting your demo company...",
  checkFailed: "The check did not pass. Try again.",
  tryAgain: "Try again",
  keepBrowsing: "Keep browsing the shared demo",
  grantTitle: "One quick check",
  grantBody: "Changes need a fresh check that you are a person. It usually passes on its own.",
  grantCancel: "Cancel",
  endedTitle: "Your demo company has ended",
  endedExpired: `Demo companies end after ${HOSTED_SETTINGS.leaseIdleMinutes} minutes without activity or ${HOSTED_SETTINGS.leaseTotalMinutes / 60} hours in all, and Weft resets them for the next visitor.`,
  endedServer: "This demo company was reset for the next visitor.",
  endedAgain: "Start a new demo company",
  endedBrowse: "Browse the shared demo",
  leased: "Your demo company",
  requestCap: "The demo has used today's shared request allowance. Pages still load; demo data comes back after 00:00 UTC.",
  apiDown: "The demo's API is not answering right now. Pages still load; try again in a minute.",
  rateLimited: "Too many requests from this network for a moment. Pages still load; try again in a minute.",
} as const;

/** The line for a lease attempt that did not lease. */
export function blockedText(r: Exclude<LeaseResult, { status: "leased" }>): string {
  switch (r.status) {
    case "waitlist": {
      const eta = r.etaMinutes === null ? "" : ` One frees in about ${Math.max(1, Math.round(r.etaMinutes))} min.`;
      return `All ${r.poolSize} demo companies are in use.${eta} You are number ${r.position} in line.`;
    }
    case "full": {
      const eta = r.etaMinutes === null ? "" : ` One frees in about ${Math.max(1, Math.round(r.etaMinutes))} min.`;
      return `All ${r.poolSize} demo companies are in use and the line is full.${eta} Try again in a few minutes.`;
    }
    case "budget": return "Today's demo budget is used up; back after 00:00 UTC.";
    case "ip_limit": return `This network has started its ${HOSTED_SETTINGS.leasesPerIpHashPerDay} demo companies for today; back after 00:00 UTC.`;
    case "closed": return "New demo companies are paused for today to stay inside the shared daily limits. The shared demo stays open.";
  }
}

/** Why new runs use the scripted provider, or null when they do not. */
export function providerNote(p: SessionStatus["provider"], agentEnabled: boolean): string | null {
  if (!agentEnabled || p.reason === "paused") return "The agent is paused on this demo for now. New runs use the scripted provider.";
  if (p.reason === "budget") return "Today's demo budget is used up, so new agent runs use the scripted provider until 00:00 UTC.";
  if (p.reason === "neurons") return "Today's Workers AI allowance is used up, so new agent runs use the scripted provider until 00:00 UTC.";
  return null;
}

/** The badge for a provider id. */
export function providerLabel(id: HostedProviderId | null): string {
  if (id === null) return "Demo default";
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
    case 3: return "Over 90% of the Durable Object rows or requests share: no new demo companies today; the shared demo stays open.";
    case 4: return "The account's Workers request cap: only static pages load until 00:00 UTC.";
  }
}

/** Hosted reset dialog lines. */
export function resetNote(resetsLeft: number | null | undefined): string {
  const left = resetsLeft ?? HOSTED_SETTINGS.resetsPerLease;
  return `On this hosted demo a reset rebuilds your own demo company (the rich demo data only). You can reset it ${HOSTED_SETTINGS.resetsPerLease} times; ${left} ${left === 1 ? "reset is" : "resets are"} left.`;
}

/** The reset error line for the hosted gate codes; null leaves the tour's own wording. */
export function hostedResetError(status: number | null, code: string | null): string | null {
  if (code === "RESET_LIMIT" || status === 429) return `You have used the ${HOSTED_SETTINGS.resetsPerLease} resets for this demo company.`;
  if (code === "HOSTED_RESET_PROFILE") return "The hosted demo resets to the rich demo data only.";
  if (code === "LEASE_REQUIRED") return "Start your own demo company first; the shared one cannot be reset.";
  return null;
}

/** "$0.0123" under a cent, else "$1.23". */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
export function usdMicros(micros: number): string { return usd(micros / 1_000_000); }
