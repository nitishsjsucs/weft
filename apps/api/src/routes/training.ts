// /v1 required training routes (wave 4, docs/wave4.md). Owner: w4-parity-compliance. Paths come from packages/contracts/src/api.ts.
// Admins read courses and every assignment; the portal reads the caller's own. Completion runs training.complete
// (human only) as the signed-in person; without a certificate upload Weft issues a completion certificate, stored like
// a receipt through the world's BlobStore (uploads/<sha256>.bin on Node).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { TrainingAssignmentStatus, TrainingCourseCode, Unauthorized, type ToolOutcome } from "@weft/contracts";
import { ptDateOf, splitByScope } from "@weft/core";
import { principals, trainingCourses } from "@weft/db";
import { eq } from "drizzle-orm";
import { COURSE_RULES, getAssignment, listAssignments } from "../../../../packages/core/src/compliance/training";
import type { Weft, WeftEnv } from "../http/context";
import { storeUpload } from "../http/uploads";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";
import { viewerScope } from "../http/scope";

const Query = z.object({ status: TrainingAssignmentStatus.optional(), workerId: z.string().startsWith("wrk_").optional(), courseCode: TrainingCourseCode.optional() });
const CompleteBody = z.object({ certificateUploadId: z.string().startsWith("upl_").optional() }).strict();
const companyOf = (c: Context<WeftEnv>) => c.var.session?.companyId ?? "cmp_larkspur";

export function trainingRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  async function complete(c: Context<WeftEnv>, own: boolean): Promise<Response> {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const body = CompleteBody.parse(await c.req.json().catch(() => ({})));
    const id = c.req.param("id")!;
    const a = await getAssignment(weft.db, id);
    if (own) {
      const [p] = await weft.db.select({ workerId: principals.workerId }).from(principals).where(eq(principals.id, s.principalId));
      if (!a || !p?.workerId || a.workerId !== p.workerId) return c.json({ _tag: "Refused", code: "NOT_FOUND", message: `No training assignment ${id} for you`, hint: null, example: null }, 404);
    }
    let certificate: { file_name: string; bytes: number; sha256: string; storage_path: string } | undefined;
    if (!body.certificateUploadId && a) {
      const now = weft.clock.now();
      const text = `Certificate of completion\n\nAssignment ${a.id}\nWorker ${a.workerId}\nCompleted ${now}\nIssued by Weft for Larkspur Robotics.\n`;
      const up = await storeUpload(weft, new TextEncoder().encode(text));
      certificate = { file_name: `certificate-${a.id}.txt`, bytes: up.bytes, sha256: up.sha256, storage_path: up.storagePath };
    }
    const out: ToolOutcome = await weft.executor.human.exec(s, "training.complete", { assignment_id: id, ...(body.certificateUploadId ? { certificate_upload_id: body.certificateUploadId } : {}), ...(certificate ? { certificate } : {}) });
    await weft.scheduler.kick();
    if (!out.ok) return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
    return c.json(out);
  }

  r.get("/v1/training/courses", async (c) => {
    const rows = await weft.db.select().from(trainingCourses).where(eq(trainingCourses.companyId, companyOf(c)));
    const basis = new Map<string, string>(COURSE_RULES.map((x) => [x.code, x.basis]));
    return c.json(rows.map((x) => ({ id: x.id, code: x.code, title: x.title, jurisdiction: x.jurisdiction, audience: x.audience, minutes: x.minutes, dueWithinDays: x.dueWithinDays, repeatMonths: x.repeatMonths, sourceUrl: x.sourceUrl, basis: basis.get(x.code) ?? null })));
  });
  r.get("/v1/training/assignments", async (c) => {
    const q = Query.parse({ status: c.req.query("status"), workerId: c.req.query("workerId"), courseCode: c.req.query("courseCode") });
    const page = parsePage(c);
    let rows = splitByScope(await viewerScope(weft, c), await listAssignments(weft.db, companyOf(c), ptDateOf(weft.clock.now()), q), (x) => x.workerId).shown;
    if (page.afterId) rows = rows.filter((x) => x.id > page.afterId!);
    return c.json(toPage(rows.slice(0, page.limit + 1), page.limit));
  });
  r.post("/v1/training/assignments/:id/complete", (c) => complete(c, false));
  r.get("/v1/portal/training", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const [p] = await weft.db.select({ workerId: principals.workerId }).from(principals).where(eq(principals.id, s.principalId));
    if (!p?.workerId) return c.json([]);
    return c.json(await listAssignments(weft.db, companyOf(c), ptDateOf(weft.clock.now()), { workerId: p.workerId }));
  });
  r.post("/v1/portal/training/:id/complete", (c) => complete(c, true));
  return stubRoutes(r, "training", ["GET /v1/training/courses", "GET /v1/training/assignments", "POST /v1/training/assignments/:id/complete", "GET /v1/portal/training", "POST /v1/portal/training/:id/complete"]);
}
