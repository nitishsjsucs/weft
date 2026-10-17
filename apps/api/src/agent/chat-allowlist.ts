// Chat allowlist choice (harness 5.3 wave 3 amendment). Owner: w3-parity-chat.
//
// Code, never the model, decides which tools a chat run gets:
// - reads: CHAT_TOOLS_W3 (16), the default for every question;
// - act: CHAT_ACT_TOOLS (16), only when the company setting `agent.chat_can_propose` is on AND the deterministic
//   intent check below reads an action request (pay, propose, approve one item, request time off). Every write on
//   that list is R2 or R4 with approval always, so chat files proposals and never executes.
// A bulk decision ("approve everything") is never an action request: there is no bulk decide command, and the run
// stays read-only so the existing refusal answers it. MCP sessions (tainted from the start) never get the act list.
// Names a track has not registered yet are dropped, so the list can only shrink, never exceed the cap of 16, and an
// act-mode write that is not proposal-only (approval always, no auto-allow) is dropped too.
// Wave 4 domain routing (FM2): when the request names the benefits carrier bill, an integration sync or who is out,
// the comms.post_update slot (never offered to chat) carries that domain's read instead. The choice is made here once,
// before the run opens, so it is frozen in the run's allowlist. Only a registered read is ever routed in.
import { eq } from "drizzle-orm";
import { CHAT_ACT_TOOLS, CHAT_DOMAIN_ROUTES, CHAT_ROUTE_SLOT, CHAT_TOOLS_W3, W3_SETTINGS, type ChatDomainRoute, type HumanSession } from "@weft/contracts";
import { settings, type Db } from "@weft/db";

export type ChatMode = "read" | "act";
export interface ChatToolChoice {
  mode: ChatMode; intent: boolean; canPropose: boolean; allowlist: string[] | null; dropped: string[];
  /** The domain read routed into the comms.post_update slot for this run, if any. */
  routed: { domain: ChatDomainRoute; tool: string } | null;
}

/** The words that name each routed domain, matched on the person's own text. Order breaks ties. */
const ROUTE_WORDS: Record<ChatDomainRoute, RegExp> = {
  benefits_reconcile: /\b(carriers?|over-?bill\w*|over-?charg\w*|reconcil\w*)\b|\bbenefits?\b[^.?!]*\b(bill\w*|invoices?|premiums?|charg\w*)\b/i,
  integrations_sync: /\b(workday|greenhouse|checkr|hireright|docusign|integrations?|sync\w*|hris|ats)\b/i,
  team_calendar: /\b(who'?s|who is|who are|anyone|anybody)\s+(out|off|away|on leave|on vacation|on pto)\b|\b(team calendar|time-?off calendar|out of (the )?office|ooo|coverage)\b/i,
};

/** The domain a request names, deterministically (first matching route in CHAT_DOMAIN_ROUTES order), or null. */
export function routedDomain(text: string): (typeof CHAT_DOMAIN_ROUTES)[number] | null {
  const t = text.trim();
  if (!t) return null;
  return CHAT_DOMAIN_ROUTES.find((r) => ROUTE_WORDS[r.domain].test(t)) ?? null;
}

/**
 * Swaps the routed read into the slot. Fails closed: no registry, an unregistered name, a name the main agent cannot
 * use, or anything that is not a read leaves the list unchanged. The list never grows.
 */
export function routeInto(registry: RegistryLike | undefined, names: readonly string[], text: string): { names: string[]; routed: ChatToolChoice["routed"] } {
  const r = routedDomain(text);
  const at = names.indexOf(CHAT_ROUTE_SLOT);
  if (!r || at < 0 || !registry || names.includes(r.tool)) return { names: [...names], routed: null };
  const known = registry.get(r.tool);
  const d = typeof registry.def === "function" ? registry.def(r.tool) : undefined;
  const effect = d?.effect ?? known?.effect;
  if (!known || known.tiers.main === "unavailable" || effect !== "read") return { names: [...names], routed: null };
  const out = [...names];
  out[at] = r.tool;
  return { names: out, routed: { domain: r.domain, tool: r.tool } };
}

/** Verbs that ask the agent to do something rather than explain something. */
const ACT_VERB = /\b(pay|propose|approve|deny|decline|reject|reimburse|issue|request|book|schedule|submit|file|run an off-cycle|send an off-cycle|make up|fix)\b/i;
/** A question about the world ("why did we pay", "how much did we pay") opens with one of these. */
const QUESTION = /^\s*(why|what|how|when|where|which|who|whose|did|does|do|is|are|was|were|has|have|had|show|list|explain|tell me|chart|graph|plot|compare)\b/i;
/** ...unless it is a polite imperative ("can you pay", "please propose"). */
const POLITE = /^\s*(please|can you|could you|would you|will you|go ahead|let'?s|i (want|need|would like) (you )?to)\b/i;
/** Bulk decisions are never acted on in chat. */
const BULK = /\b(approve|deny|decline|reject)\b[^.?!]*\b(everything|all|every|each|in bulk|at once|the rest)\b|\b(everything|all|every)\b[^.?!]*\b(approve|deny|decline|reject)/i;

/** Deterministic action-intent check over the person's own words. */
export function readsActionIntent(text: string): boolean {
  const t = text.trim();
  if (!t || BULK.test(t)) return false;
  if (!ACT_VERB.test(t)) return false;
  return !QUESTION.test(t) || POLITE.test(t);
}

/** `agent.chat_can_propose` from the settings table: JSON `true` (or "on") turns it on; anything else is off. */
export async function chatCanPropose(db: Db): Promise<boolean> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, W3_SETTINGS.chatCanPropose)).limit(1);
    if (!row) return false;
    const v = JSON.parse(row.valueJson) as unknown;
    return v === true || v === "on";
  } catch { return false; }
}

interface RegistryLike {
  get(name: string): { tiers: { main: string }; effect?: string } | undefined;
  /** The full definition (the executor's registry has it at runtime); keeps act-mode writes proposal-only. */
  def?(name: string): { effect: string; approval: unknown; autoAllow: string } | undefined;
  toolSpecs?(input: { agentKind: "main"; allowlist: string[] }): readonly { name: string; parameters: unknown }[];
}

/**
 * Harness 5.3 wave 3 amendment: every write chat can propose has `approval: "always"` and no auto-allow, so the
 * policy can only answer propose (or refuse) for it. A write a track registers with a looser rule (an amount
 * threshold, or auto-allow for untainted runs) could execute from chat, so the act list drops it instead. Writes
 * already on the read list (comms.post_update, hidden from chat by the loop) are not act-mode additions.
 */
export function notProposalOnly(registry: RegistryLike | undefined, names: readonly string[]): string[] {
  if (!registry) return [];
  const reads = new Set<string>(CHAT_TOOLS_W3);
  return names.filter((n) => {
    const known = registry.get(n);
    if (!known || reads.has(n) || known.effect === "read") return false;   // unregistered names are dropped by registered()
    // Fail closed: a write whose approval rule cannot be read is not offered.
    const d = typeof registry.def === "function" ? registry.def(n) : undefined;
    if (!d) return true;
    if (d.effect === "read") return false;
    return d.approval !== "always" || d.autoAllow !== "never";
  });
}

/**
 * Keywords a strict function-calling provider refuses in a tool schema. One refused schema fails the whole request,
 * so a live run drops that tool instead of failing every step (z.record inputs render `propertyNames`). No registered
 * command has one since payroll.propose_off_cycle took `bonuses` as an array; strictSchemaProblems now flags them too.
 */
const STRICT_REFUSED = /"(propertyNames|patternProperties)"\s*:/;
export function strictUnsafe(registry: RegistryLike | undefined, names: readonly string[]): string[] {
  if (!registry?.toolSpecs) return [];
  return names.filter((n) => {
    try { return STRICT_REFUSED.test(JSON.stringify(registry.toolSpecs!({ agentKind: "main", allowlist: [n] })[0]?.parameters ?? {})); } catch { return false; }
  });
}

/** The names the registry knows and offers to the main agent, in list order; null when no registry is wired (route tests). */
export function registered(registry: RegistryLike | undefined, names: readonly string[]): string[] | null {
  if (!registry || typeof registry.get !== "function") return null;
  return names.filter((n) => { const d = registry.get(n); return Boolean(d && d.tiers.main !== "unavailable"); });
}

/**
 * `liveProvider`: the run goes to a real model with strict tool schemas (the scripted provider never validates them).
 * `route: false` turns domain routing off (the pre-wave-4 lists, for comparison runs).
 */
export async function chooseChatTools(deps: { db: Db; registry?: RegistryLike; liveProvider?: boolean; route?: boolean }, session: Pick<HumanSession, "keyScope">, text: string): Promise<ChatToolChoice> {
  const intent = readsActionIntent(text);
  const canPropose = intent ? await chatCanPropose(deps.db) : false;
  const mode: ChatMode = intent && canPropose && session.keyScope !== "mcp" ? "act" : "read";
  const listed = registered(deps.registry, mode === "act" ? CHAT_ACT_TOOLS : CHAT_TOOLS_W3);
  const { names, routed } = listed && deps.route !== false ? routeInto(deps.registry, listed, text) : { names: listed, routed: null };
  const loose = names && mode === "act" ? notProposalOnly(deps.registry, names) : [];
  const dropped = [...loose, ...(names && deps.liveProvider ? strictUnsafe(deps.registry, names.filter((n) => !loose.includes(n))) : [])];
  return { mode, intent, canPropose, allowlist: names ? names.filter((n) => !dropped.includes(n)) : null, dropped, routed: routed && !dropped.includes(routed.tool) ? routed : null };
}
