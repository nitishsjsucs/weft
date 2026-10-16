// /v1 documents routes (wave 2, docs/wave2.md). Owner: w2-onboarding. The person view's document library, one
// document with its signature record, and the email simulator's outbox.
import { Hono } from "hono";
import { DocumentStatus, NotFound, ValidationError } from "@weft/contracts";
import { getDocument, listWorkerDocuments, signatureOf, toDocumentDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

export function documentsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/workers/:id/documents", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const st = c.req.query("status");
    const status = st ? DocumentStatus.safeParse(st) : null;
    if (status && !status.success) throw new ValidationError(`status must be one of ${DocumentStatus.options.join(", ")}`);
    const rows = await listWorkerDocuments(weft.db, companyId, c.req.param("id"), status?.data);
    return c.json(rows.map(toDocumentDto));
  });
  r.get("/v1/documents/:id", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const d = await getDocument(weft.db, companyId, c.req.param("id"));
    if (!d) throw new NotFound(`No document ${c.req.param("id")}`);
    const s = await signatureOf(weft.db, d.id);
    return c.json({ ...toDocumentDto(d), bodyText: d.bodyText, signature: s ? { id: s.id, signerPrincipalId: s.signerPrincipalId, signerName: s.signerName, typedName: s.typedName, signedAt: s.signedAt, documentSha256: s.documentSha256, actionSeq: s.actionSeq } : null });
  });
  r.get("/v1/sim/email", async (c) => {
    const to = c.req.query("to") || undefined;
    return c.json(await weft.sims.email.list(to));
  });
  return stubRoutes(r, "documents", ["GET /v1/workers/:id/documents", "GET /v1/documents/:id", "GET /v1/sim/email"]);
}
