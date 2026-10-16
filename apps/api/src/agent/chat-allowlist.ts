// Chat allowlist choice (harness 5.3 wave 3 amendment). Owner: w3-parity-chat.
//
// Code, never the model, decides which tools a chat run gets:
// - reads: CHAT_TOOLS_W3 (16), the default for every question;
// - act: CHAT_ACT_TOOLS (16), only when the company setting `agent.chat_can_propose` is on AND the deterministic
//   intent check below reads an action request (pay, propose, approve one item, request time off). Every write on
//   that list is R2 or R4 with approval always, so chat files proposals and never executes.
// A bulk decision ("approve everything") is never an action request: there is no bulk decide command, and the run
// stays read-only so the existing refusal answers it. MCP sessions (tainted from the start) never get the act list.
// Names a track has not registered yet are dropped, so the list can only shrink, never exceed the cap of 16.
import { eq } from "drizzle-orm";
import { CHAT_ACT_TOOLS, CHAT_TOOLS_W3, W3_SETTINGS, type HumanSession } from "@weft/contracts";
import { settings, type Db } from "@weft/db";

export type ChatMode = "read" | "act";
export interface ChatToolChoice { mode: ChatMode; intent: boolean; canPropose: boolean; allowlist: string[] | null; dropped: string[] }

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
  get(name: string): { tiers: { main: string } } | undefined;
  toolSpecs?(input: { agentKind: "main"; allowlist: string[] }): readonly { name: string; parameters: unknown }[];
}

/**
 * Keywords a strict function-calling provider refuses in a tool schema. One refused schema fails the whole request,
 * so a live run drops that tool instead of failing every step (z.record inputs render `propertyNames`; see
 * docs/tracks/w3-parity-chat.md for the contract request on payroll.propose_off_cycle's bonus_cents).
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

/** `liveProvider`: the run goes to a real model with strict tool schemas (the scripted provider never validates them). */
export async function chooseChatTools(deps: { db: Db; registry?: RegistryLike; liveProvider?: boolean }, session: Pick<HumanSession, "keyScope">, text: string): Promise<ChatToolChoice> {
  const intent = readsActionIntent(text);
  const canPropose = intent ? await chatCanPropose(deps.db) : false;
  const mode: ChatMode = intent && canPropose && session.keyScope !== "mcp" ? "act" : "read";
  const names = registered(deps.registry, mode === "act" ? CHAT_ACT_TOOLS : CHAT_TOOLS_W3);
  const dropped = names && deps.liveProvider ? strictUnsafe(deps.registry, names) : [];
  return { mode, intent, canPropose, allowlist: names ? names.filter((n) => !dropped.includes(n)) : null, dropped };
}
