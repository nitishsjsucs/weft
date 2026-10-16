// Greenhouse hire to a Weft draft offer (research/wave3/integrations-hr.md 3.2 F1 and 3.3). Owner: w3-integrations-hr.
// integrations.record_ats_hire re-reads the hire from the connector (never the webhook body), maps department and
// office through the connection's value maps, creates exactly one draft offer per application through the existing
// documents.create_offer logic, links it in ext_links and snapshots the vendor values. A later offer version that
// changes the start date or salary opens a human-only sync conflict; Weft never overwrites silently.
import { and, eq } from "drizzle-orm";
import type { AtsHire, AtsJob, ExecContext, IntegrationVendor } from "@weft/contracts";
import { departments, extLinks, integrationDeliveries, offers, workplaces } from "@weft/db";
import type { CommandDeps } from "../shared/deps";
import { createOffer, OFFER_STATES } from "../portal/offers";
import { findLink, getConnection, openSyncItem, readSnapshot, settingsOf, valueHash, writeSnapshot } from "./store";

const STATE_RE = /(?:^|[\s,])(CA|NY|TX|CO)(?:$|[\s,])/;

export async function allJobs(deps: CommandDeps): Promise<AtsJob[]> {
  const out: AtsJob[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page = await deps.sims.vendors.greenhouse.listJobs({ cursor, source: "harvest" });
    out.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export interface Mapped { departmentId: string | null; workplaceId: string; workState: string | null; job: AtsJob | null; unmapped: { field: "department" | "office"; extId: string; extName: string; fallback: string }[] }

/** Department and office of a hire through the connection maps, then the department name; offices fall back to Remote US with the state from the job location. */
export async function mapHire(deps: CommandDeps, ctx: ExecContext, hire: AtsHire): Promise<Mapped> {
  const s = settingsOf(await getConnection(deps.tx, ctx.companyId, "greenhouse"));
  const jobs = await allJobs(deps);
  const job = jobs.find((j) => j.name === hire.jobName) ?? null;
  const unmapped: Mapped["unmapped"] = [];
  let departmentId: string | null = hire.departmentExtId ? s.departments?.[hire.departmentExtId] ?? null : null;
  if (!departmentId && job?.departmentName) {
    const [d] = await deps.tx.select().from(departments).where(and(eq(departments.companyId, ctx.companyId), eq(departments.name, job.departmentName))).limit(1);
    departmentId = d?.id ?? null;
    if (!d) unmapped.push({ field: "department", extId: hire.departmentExtId ?? "", extName: job.departmentName, fallback: "" });
  }
  let workplaceId = "wkp_remote", workState: string | null = null;
  const wkp = hire.officeExtId ? s.offices?.[hire.officeExtId] ?? null : null;
  if (wkp) {
    const [w] = await deps.tx.select().from(workplaces).where(and(eq(workplaces.companyId, ctx.companyId), eq(workplaces.id, wkp))).limit(1);
    if (w) { workplaceId = w.id; workState = w.state; }
  }
  if (!workState) {
    workState = STATE_RE.exec(job?.location ?? "")?.[1] ?? null;
    if (hire.officeExtId && !wkp) unmapped.push({ field: "office", extId: hire.officeExtId, extName: job?.officeName ?? hire.officeExtId, fallback: "wkp_remote" });
  }
  return { departmentId, workplaceId, workState, job, unmapped };
}

const vendorFields = (h: AtsHire) => ({ start_date: h.startDate, salary_minor: h.salary?.amountMinor ?? null, salary_currency: h.salary?.currency ?? null });

export async function markDelivery(deps: CommandDeps, deliveryId: string | undefined, now: string, error: string | null): Promise<void> {
  if (!deliveryId) return;
  await deps.tx.update(integrationDeliveries).set(error ? { error } : { appliedAt: now, error: null }).where(eq(integrationDeliveries.id, deliveryId));
}

export interface RecordHireResult { outcome: "imported" | "unchanged" | "conflict" | "blocked"; offer_id: string | null; sync_item_ids: string[]; application_ref: string; offer_version: number | null; events: { type: string; subjectRef: string; payload: Record<string, string> }[] }

export async function recordAtsHire(deps: CommandDeps, ctx: ExecContext, vendor: IntegrationVendor, applicationRef: string, deliveryId: string | undefined): Promise<RecordHireResult> {
  const now = ctx.now;
  const hire = await deps.sims.vendors.greenhouse.getHire(applicationRef);
  const events: RecordHireResult["events"] = [];
  const opened: string[] = [];
  const open = async (kind: "sync_conflict" | "unmapped_value" | "permission_gap", subjectRef: string, key: string, detail: Record<string, string>) => {
    const r = await openSyncItem(deps, ctx.companyId, now, { vendor, kind, subjectRef, key, detail });
    opened.push(r.id);
    if (r.created) events.push({ type: "integration.sync_item_opened", subjectRef, payload: { sync_item_id: r.id } });
  };
  if (!hire) {
    await open("permission_gap", `greenhouse:application:${applicationRef}`, "hire_unreadable", { application_ref: applicationRef, reason: "The hire or its accepted offer could not be read. Offers may be hidden by the API user's permissions." });
    await markDelivery(deps, deliveryId, now, "hire_unreadable");
    return { outcome: "blocked", offer_id: null, sync_item_ids: opened, application_ref: applicationRef, offer_version: null, events };
  }
  const link = await findLink(deps.tx, vendor, "application", hire.applicationId);
  if (link) {
    if ((link.extVersion ?? 0) >= hire.offerVersion) {
      await markDelivery(deps, deliveryId, now, null);
      return { outcome: "unchanged", offer_id: link.weftId, sync_item_ids: [], application_ref: hire.applicationId, offer_version: hire.offerVersion, events };
    }
    const snap = await readSnapshot(deps.tx, vendor, "application", hire.applicationId);
    const [o] = await deps.tx.select().from(offers).where(eq(offers.id, link.weftId)).limit(1);
    const incoming = vendorFields(hire);
    if (o && snap.start_date !== valueHash(incoming.start_date) && incoming.start_date) {
      await open("sync_conflict", o.id, `start_date:${incoming.start_date}`, { field: "start_date", label: "Start date", weft_value: o.startDate, vendor_value: incoming.start_date, offer_version: String(hire.offerVersion), application_ref: hire.applicationId });
    }
    if (o && snap.salary_minor !== valueHash(incoming.salary_minor) && incoming.salary_minor !== null) {
      await open("sync_conflict", o.id, `base_cents:${incoming.salary_minor}`, { field: "base_cents", label: "Base salary (cents)", weft_value: String(o.baseCents), vendor_value: String(incoming.salary_minor), offer_version: String(hire.offerVersion), application_ref: hire.applicationId });
    }
    await deps.tx.update(extLinks).set({ extVersion: hire.offerVersion, updatedAt: now }).where(eq(extLinks.id, link.id));
    await writeSnapshot(deps.tx, vendor, "application", hire.applicationId, incoming, now);
    await markDelivery(deps, deliveryId, now, null);
    return { outcome: opened.length ? "conflict" : "unchanged", offer_id: link.weftId, sync_item_ids: opened, application_ref: hire.applicationId, offer_version: hire.offerVersion, events };
  }

  const m = await mapHire(deps, ctx, hire);
  const subject = `greenhouse:application:${hire.applicationId}`;
  const block = async (key: string, detail: Record<string, string>) => {
    await open("unmapped_value", subject, key, { application_ref: hire.applicationId, ...detail });
    await markDelivery(deps, deliveryId, now, `blocked:${key}`);
    return { outcome: "blocked" as const, offer_id: null, sync_item_ids: opened, application_ref: hire.applicationId, offer_version: hire.offerVersion, events };
  };
  if (!hire.salary) return block("salary", { field: "salary", reason: "The accepted offer carries no salary custom field." });
  if (hire.salary.currency !== "USD") return block("salary_currency", { field: "salary_currency", vendor_value: hire.salary.currency, reason: "Weft pays in USD only." });
  if (!hire.startDate) return block("start_date", { field: "start_date", reason: "The accepted offer has no start date." });
  if (!m.departmentId) return block("department", { field: "department", ext_id: hire.departmentExtId ?? "", ext_name: m.job?.departmentName ?? "", reason: "No Weft department matches this Greenhouse department." });
  if (!m.workState || !(OFFER_STATES as readonly string[]).includes(m.workState)) return block("office", { field: "office", ext_id: hire.officeExtId ?? "", ext_name: m.job?.officeName ?? "", reason: "The work state could not be resolved from the office. Map the office to a Weft workplace." });

  // Candidate-entered names and the job title land in trusted offer and worker columns, so only plain name and title
  // text is imported; anything else waits for a human in the Integrations screen.
  const title = hire.jobName.replace(/\s*\(demo\)\s*$/, "");
  if (!plainText(hire.first, NAME_RE, 3) || !plainText(hire.last, NAME_RE, 4)) return block("candidate_name", { field: "candidate_name", reason: "The candidate name has characters Weft does not import. Enter the offer by hand." });
  if (!plainText(title, TITLE_RE, 8)) return block("job_title", { field: "job_title", reason: "The job title has characters Weft does not import. Enter the offer by hand." });

  const args = createOffer.input.parse({
    candidate_first: hire.first, candidate_last: hire.last, candidate_email: hire.email, title, department_id: m.departmentId,
    workplace_id: m.workplaceId, work_state: m.workState, base_cents: hire.salary.amountMinor, pay_kind: "salary", start_date: hire.startDate,
  });
  const created = (await createOffer.run(args, ctx, deps)) as unknown as { data: { offer_id: string } };
  const offerId = created.data.offer_id;
  await deps.tx.insert(extLinks).values({ id: await deps.newId("extl_"), companyId: ctx.companyId, vendor, extType: "application", extId: hire.applicationId, weftType: "offer", weftId: offerId, extVersion: hire.offerVersion, status: "linked", createdAt: now, updatedAt: now });
  await writeSnapshot(deps.tx, vendor, "application", hire.applicationId, vendorFields(hire), now);
  for (const u of m.unmapped) {
    await open("unmapped_value", offerId, `${u.field}:${u.extId}`, { field: u.field, ext_id: u.extId, ext_name: u.extName, fallback: u.fallback, work_state: m.workState, application_ref: hire.applicationId, reason: u.field === "office" ? "This Greenhouse office has no Weft workplace yet. The offer uses Remote US with the state from the office location." : "No Weft department matched." });
  }
  events.unshift({ type: "offer.imported", subjectRef: offerId, payload: { offer_id: offerId, vendor } });
  await markDelivery(deps, deliveryId, now, null);
  return { outcome: "imported", offer_id: offerId, sync_item_ids: opened, application_ref: hire.applicationId, offer_version: hire.offerVersion, events };
}

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '\u2019.-]*$/u;
const TITLE_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ,'\u2019&/().-]*$/u;
/** Letters (and the punctuation names and titles use), at most `words` words: no colons, brackets or sentences. */
function plainText(v: string, re: RegExp, words: number): boolean {
  const t = v.trim();
  return t.length > 0 && re.test(t) && t.split(/\s+/).length <= words;
}
