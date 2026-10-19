// Chat simulator: an in-app feed over the closed channel enum (SPEC 8). Cards are written only by the proposal
// notifier; messages from people are inbound and untrusted.
import { and, asc, eq, gt } from "drizzle-orm";
import { ChatChannel as ChatChannelEnum, MENTION_HANDLE, type ChatChannel, type ChatMessage, type ChatSim, type FaultInjector, type SimClock } from "@weft/contracts";
import { simChatMessages, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";

export const CHAT_CHANNELS = ChatChannelEnum.options;
export const MAX_CHAT_TEXT = 4000;

export interface ChatSimInternal extends ChatSim {
  /** Seed and demo only: a message typed by a (fictional) person. Inbound text is untrusted. */
  postInbound(msg: { channel: ChatChannel; author: string; text: string }): Promise<{ id: string }>;
}

export function createChatSim(db: DbTx, clock: SimClock, faults: FaultInjector): ChatSimInternal {
  const insert = async (msg: { channel: ChatChannel; author: string; text: string; card?: unknown }, inbound: boolean) => {
    if (!CHAT_CHANNELS.includes(msg.channel)) throw new Error(`chat.post: unknown channel ${String(msg.channel)}`);
    if (msg.text.length === 0 || msg.text.length > MAX_CHAT_TEXT) throw new Error("chat.post: text must be 1 to 4000 characters");
    const id = await mintId(db, "simc_");
    await db.insert(simChatMessages).values({ id, channel: msg.channel, author: msg.author, text: msg.text, inbound, cardJson: msg.card ? JSON.stringify(msg.card) : null, ts: clock.now() });
    return { id };
  };
  return {
    async post(msg) {
      const fault = await firstFault(faults, ["chat.post"]);
      if (fault === "error") throw new SimFaultError("chat.post");
      return insert(msg, false);
    },
    postInbound: (msg) => insert(msg, true),
    async list(channel, afterId) {
      const rows = await db.select().from(simChatMessages)
        .where(afterId ? and(eq(simChatMessages.channel, channel), gt(simChatMessages.id, afterId)) : eq(simChatMessages.channel, channel))
        .orderBy(asc(simChatMessages.id));
      // A channel reads in time order (imported history can carry later ids than the messages it predates); an
      // incremental read after a cursor stays in id order, so the cursor still moves forward.
      if (!afterId) rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
      return rows.map((r): ChatMessage => ({ id: r.id, channel: r.channel as ChatChannel, author: r.author, text: r.text, card: r.cardJson ? JSON.parse(r.cardJson) : null, ts: r.ts, inbound: r.inbound }));
    },
  };
}

// Wave 4 (w4-parity-agent, Q6): tagging the agent. The handle must stand alone ("@weft", "@weft,"), not prefix a word.
const MENTION_RE = new RegExp(`(^|[^\\w@])${MENTION_HANDLE}(?![\\w-])`, "i");
/** True when the message names the agent handle as a word. */
export function mentionsAgent(text: string): boolean { return MENTION_RE.test(text); }
/** The message with the handle removed, for the run's request line. */
export function stripMention(text: string): string {
  return text.replace(new RegExp(`(^|[^\\w@])${MENTION_HANDLE}(?![\\w-])[,:]?\\s*`, "gi"), "$1").replace(/\s{2,}/g, " ").trim() || text.trim();
}
