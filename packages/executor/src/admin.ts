// Human-only administration (settings, agent grants, API keys): the change and its hash-chained action row in one
// transaction, so every state change is in the audit log (harness 2).
import { randomBytes, createHash } from "node:crypto";
import type { ExecutorBundle, HumanSession } from "@weft/contracts";
import { newId } from "@weft/core";
import { apiKeys, withWriteLock, type DbTx } from "@weft/db";
import { appendAction } from "./chain";
import { digestOf } from "./digest";
import type { Engine } from "./engine";
import { afterCommit } from "./timeline";
import { loadPrincipal } from "./store";

export class AdminRefused extends Error { constructor(readonly code: "UI_SESSION_REQUIRED" | "WRONG_ROLE", message: string) { super(message); } }

export async function adminChange<T>(e: Engine, session: HumanSession, command: string, args: unknown, summary: string, apply: (tx: DbTx) => Promise<T>): Promise<{ result: T; seq: number }> {
  if (session.via !== "ui") throw new AdminRefused("UI_SESSION_REQUIRED", "administration accepts only the UI session");
  const p = await loadPrincipal(e.db, session.principalId);
  if (!p || p.kind !== "human" || p.companyId !== session.companyId || p.grants.company !== "approve") throw new AdminRefused("WRONG_ROLE", "only an admin can change settings and keys");
  const out = await withWriteLock(() => e.db.transaction(async (tx) => {
    const result = await apply(tx);
    const a = await appendAction(tx, {
      ts: e.clock.now(), actorKind: "human", actorId: p.id, onBehalfOf: null, agentRunId: null, routineRunId: null, proposalId: null, command,
      argsJson: JSON.stringify(e.redactor.value(args ?? {})), argsHash: digestOf(args), resultId: null, resultDigest: digestOf(e.redactor.value(result ?? null)),
      summary, reversible: "no", reverseJson: null, reversesSeq: null,
    });
    return { result, seq: a.seq };
  }));
  await afterCommit(e, { ok: true, status: "done", resultId: "admin", data: null, summary, actionSeq: out.seq, artifactRef: null, tainted: false, label: "synthetic" });
  return out;
}

export async function createApiKey(e: Engine, session: HumanSession, input: { label: string; scope: "mcp" | "cli" | "admin" }): Promise<{ id: string; plaintext: string; prefix: string; scope: string; surface: string; label: string; createdAt: string }> {
  const plaintext = `weft_sk_${randomBytes(24).toString("hex")}`;
  e.redactor.add(plaintext);
  const surface = input.scope === "mcp" ? "mcp" : "api";
  const { result } = await adminChange(e, session, "settings.create_api_key", { label: input.label, scope: input.scope }, `Created a ${input.scope}-scope API key`, async (tx) => {
    const id = await newId(tx, "key_");
    const createdAt = e.clock.now();
    await tx.insert(apiKeys).values({ id, companyId: session.companyId, principalId: session.principalId, prefix: plaintext.slice(0, 16),
      hash: createHash("sha256").update(plaintext).digest("hex"), label: input.label, scope: input.scope, surface, createdAt, revokedAt: null });
    return { id, prefix: plaintext.slice(0, 16), scope: input.scope, surface, label: input.label, createdAt };
  });
  return { ...result, plaintext };
}

export type { ExecutorBundle };
