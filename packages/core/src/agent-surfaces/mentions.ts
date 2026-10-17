// Tagging the agent in a simulated chat thread (Q6, docs/wave4.md). Owner: w4-parity-agent.
// agent.record_mention (system only) stores one agent_mentions row per inbound message that names MENTION_HANDLE.
// The thread text is untrusted: the API opens the answering run tainted from its first step, gives it read tools
// only, and posts exactly one reply in the thread from the run's final answer.
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ChatChannel, type AgentMention, type AgentMentionStatus } from "@weft/contracts";
import { agentMentions, type Db, type DbTx } from "@weft/db";
import { riskOf, writeCommand } from "../demo/define";

type MentionRow = typeof agentMentions.$inferSelect;
export const toMention = (r: MentionRow): AgentMention => ({
  id: r.id, channel: r.channel, messageRef: r.messageRef, threadRef: r.threadRef, mentionedBy: r.mentionedBy, status: r.status as AgentMentionStatus,
  runId: r.runId, createdAt: r.createdAt, answeredAt: r.answeredAt,
});

const RecordInput = z.object({
  channel: ChatChannel, message_ref: z.string().startsWith("simc_"), thread_ref: z.string().startsWith("simc_").optional(),
  mentioned_by: z.string().min(1).max(80), status: z.enum(["queued", "ignored"]).optional(),
}).strict();

export const recordMention = writeCommand<z.infer<typeof RecordInput>>({
  name: "agent.record_mention", summary: "Record that a chat message tagged the agent (system only)",
  description: "System only: records one mention of the agent handle in a simulated chat message, keyed by the message id. A second call for the same message returns the existing row. The message text is not stored here.",
  input: RecordInput, domain: "comms", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const [existing] = await deps.tx.select().from(agentMentions).where(eq(agentMentions.messageRef, i.message_ref)).limit(1);
    if (existing) return { data: { mention_id: existing.id, status: existing.status, duplicate: true }, summary: `Mention ${existing.id} was already recorded` };
    const id = await deps.newId("mnt_");
    const status = i.status ?? "queued";
    await deps.tx.insert(agentMentions).values({
      id, companyId: ctx.companyId, channel: i.channel, messageRef: i.message_ref, threadRef: i.thread_ref ?? i.message_ref, mentionedBy: i.mentioned_by,
      status, runId: null, createdAt: ctx.now, answeredAt: null,
    });
    return {
      data: { mention_id: id, status, duplicate: false }, summary: `Recorded mention ${id} in ${i.channel}`,
      events: status === "queued" ? [{ type: "chat.agent_mentioned", subjectRef: id, payload: { mention_id: id } }] : [],
    };
  },
});

/** Mention bookkeeping after the run (the row is this track's; the run's own effects go through the executor). */
export async function updateMention(db: Db | DbTx, id: string, patch: Partial<Pick<MentionRow, "status" | "runId" | "answeredAt">>): Promise<void> {
  await db.update(agentMentions).set(patch).where(eq(agentMentions.id, id));
}

export async function listMentions(db: Db | DbTx, companyId: string, status?: string | null): Promise<AgentMention[]> {
  const rows = await db.select().from(agentMentions).where(status ? and(eq(agentMentions.companyId, companyId), eq(agentMentions.status, status)) : eq(agentMentions.companyId, companyId)).orderBy(desc(agentMentions.id)).limit(100);
  return rows.map(toMention);
}

export async function getMention(db: Db | DbTx, id: string): Promise<AgentMention | null> {
  const [r] = await db.select().from(agentMentions).where(eq(agentMentions.id, id)).limit(1);
  return r ? toMention(r) : null;
}

/** The reply posted in the thread: the run's final answer, clipped to one chat message, with the thread named. */
export function mentionReply(answer: string | null, status: string): string {
  const body = (answer ?? "").trim() || (status === "done" ? "I looked, but I have nothing to add." : "I could not answer this one; a person on the team will pick it up.");
  return body.length > 3800 ? `${body.slice(0, 3797)}...` : body;
}
