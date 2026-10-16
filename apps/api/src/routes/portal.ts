// /v1 portal routes (wave 2, docs/wave2.md). Owner: w2-onboarding. The new hire persona's checklist: read the view,
// open the offer, click-to-sign, Form W-4, the state certificate, direct deposit, the I-9 upload and benefits.
// Writes run onboarding.* human_only commands through the executor; the persona reaches only /v1/portal/* (auth.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { DirectDepositSubmission, Forbidden, Unauthorized, type HumanSession } from "@weft/contracts";
import { loadPersona, portalView } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { outcomeJson } from "./offers";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

function need(session: HumanSession | null): HumanSession {
  if (!session) throw new Unauthorized();
  return session;
}
const maskName = (n: string) => `${n.slice(0, 2)}***${/\.[A-Za-z0-9]{1,5}$/.exec(n)?.[0] ?? ""}`;
const refusedJson = (code: string, message: string) => ({ ok: false, _tag: "Refused", code, message, refusal: { code, message, hint: null, example: null } });

export function portalRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  const persona = async (s: HumanSession) => {
    const p = await loadPersona(weft.db, s.companyId, s.principalId);
    if (!p) throw new Forbidden("Only the new hire persona has a portal", { code: "NOT_NEW_HIRE" });
    return p;
  };

  r.get("/v1/portal/me", async (c) => {
    const s = need(c.var.session);
    const view = await portalView(weft.db, s.companyId, s.principalId);
    if (!view) throw new Forbidden("Only the new hire persona has a portal", { code: "NOT_NEW_HIRE" });
    return c.json(view);
  });

  r.post("/v1/portal/offer/view", async (c) => outcomeJson(c, await weft.executor.human.exec(need(c.var.session), "documents.view_offer", {})));

  r.post("/v1/portal/documents/:id/sign", async (c) => {
    const s = need(c.var.session);
    const b = (await c.req.json().catch(() => ({}))) as { typedName?: unknown; documentSha256?: unknown };
    // An unopened offer is marked viewed, and one past expires_on expired, before the signature is checked.
    const p = await loadPersona(weft.db, s.companyId, s.principalId);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(weft.clock.now()));
    if (p && (p.offer.status === "sent" || (p.offer.status === "viewed" && !!p.offer.expiresOn && day > p.offer.expiresOn))) await weft.executor.human.exec(s, "documents.view_offer", {});
    const out = await weft.executor.human.exec(s, "documents.sign", { document_id: c.req.param("id"), typed_name: b.typedName, document_sha256: b.documentSha256 });
    return outcomeJson(c, out);
  });

  for (const [path, command] of [["/v1/portal/w4", "documents.submit_w4"], ["/v1/portal/state-withholding", "documents.submit_state_withholding"], ["/v1/portal/benefits", "documents.submit_benefits"]] as const) {
    r.post(path, async (c) => {
      const s = need(c.var.session);
      const out = await weft.executor.human.exec(s, command, await c.req.json().catch(() => ({})));
        return outcomeJson(c, out);
    });
  }

  // Full routing and account numbers stop here: validated (ABA checksum), vaulted, and only the last 4 digits and
  // the vault reference go to the command, its action row and the bank_accounts row.
  r.post("/v1/portal/direct-deposit", async (c) => {
    const s = need(c.var.session);
    const p = await persona(s);
    const parsed = DirectDepositSubmission.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ ...refusedJson("INVALID_INPUT", `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`), field: issue?.path.join(".") ?? null }, 422);
    }
    const d = parsed.data;
    const name = `bank-${p.workerId.replace(/_/g, "-")}`;
    await weft.executor.vault.put({ name, kind: "bank_account", value: JSON.stringify({ routing: d.routing, account: d.account }), description: `Direct deposit for ${p.workerId} (demo)`, by: s.principalId });
    const out = await weft.executor.human.exec(s, "documents.submit_direct_deposit", {
      bank_name: d.bankName, routing_last4: d.routing.slice(-4), account_last4: d.account.slice(-4), account_type: d.accountType, credential_ref: `vault:${name}`, typed_name: d.typedName,
    });
    return outcomeJson(c, out);
  });

  // I-9: multipart (fields plus idImage). The file is stored under the data dir in uploads/; responses are masked.
  r.post("/v1/portal/i9", async (c) => {
    const s = need(c.var.session);
    await persona(s);
    const body = await c.req.parseBody().catch(() => null);
    if (!body) return c.json(refusedJson("INVALID_INPUT", "Send multipart form data with the I-9 fields and idImage"), 422);
    const file = body.idImage;
    if (!(file instanceof File)) return c.json(refusedJson("INVALID_INPUT", "idImage: attach an image of your ID"), 422);
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) return c.json(refusedJson("INVALID_INPUT", "idImage: the file must be between 1 byte and 5 MB"), 422);
    if (!UPLOAD_TYPES.has(file.type)) return c.json(refusedJson("INVALID_INPUT", "idImage: use a PNG, JPEG, WebP or PDF file"), 422);
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    const rel = `uploads/${sha}.bin`;
    const abs = join(weft.dataDir, rel);
    const fresh = !existsSync(abs);
    mkdirSync(join(weft.dataDir, "uploads"), { recursive: true });
    if (fresh) writeFileSync(abs, bytes, { mode: 0o600 });
    const field = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const out = await weft.executor.human.exec(s, "documents.submit_i9", {
      citizenship: field("citizenship"), documentKind: field("documentKind"), documentNumberLast4: field("documentNumberLast4"),
      expiresOn: field("expiresOn") || null, typedName: field("typedName"),
      // Only the masked name travels into the command, its action row and the uploads row.
      file_name: maskName(file.name || "id-image"), bytes: bytes.length, sha256: sha, storage_path: rel,
    });
    if (!out.ok && fresh) { try { unlinkSync(abs); } catch { /* already gone */ } }
    return outcomeJson(c, out);
  });

  return stubRoutes(r, "portal", ["GET /v1/portal/me", "POST /v1/portal/offer/view", "POST /v1/portal/documents/:id/sign", "POST /v1/portal/w4", "POST /v1/portal/state-withholding", "POST /v1/portal/direct-deposit", "POST /v1/portal/i9", "POST /v1/portal/benefits"]);
}
