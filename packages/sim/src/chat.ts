// Chat simulator: an in-app feed over the closed channel enum (SPEC 8). Cards are written only by the proposal
// notifier; messages from people are inbound and untrusted.
import { and, asc, eq, gt } from "drizzle-orm";
import { ChatChannel as ChatChannelEnum, type ChatChannel, type ChatMessage, type ChatSim, type FaultInjector, type SimClock } from "@weft/contracts";
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
      return rows.map((r): ChatMessage => ({ id: r.id, channel: r.channel as ChatChannel, author: r.author, text: r.text, card: r.cardJson ? JSON.parse(r.cardJson) : null, ts: r.ts, inbound: r.inbound }));
    },
  };
}
