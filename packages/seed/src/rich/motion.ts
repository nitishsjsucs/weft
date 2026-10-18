// Rich profile, part 2: hiring in every offer state, an accepted hire who is still onboarding, the approvals waiting
// this week, paid expense history, integration deliveries and sync items, reconciliation history, device orders and
// the contractors' accounts and documents. Same rules as rich/index.ts: add rows, never edit a planted one.
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  benefitReconFindings, contractorTaxForms, devices, documents, enrollmentWindows, expenses, extLinks, integrationDeliveries, itAccounts, offers, onboardingTasks, payRates,
  payrollRuns, principals, screeningOrders, simDeviceOrders, simEmailMessages, syncItems, taxProfiles, workers, type DbTx,
} from "@weft/db";
import { newId, payroll, sha256Hex } from "@weft/core";

const CO = "cmp_larkspur";
const pt = (date: string, hour: number, minute = 0) => payroll.ptToUtc(date, hour, minute);
const DEMO_DOC = "DEMO DOCUMENT. Fictional company, fictional person, simulated signature. Not a real record.";
type W = typeof workers.$inferSelect;
type Bump = (table: string, n?: number) => void;
type Proposal = (p: Record<string, unknown>) => Promise<string>;
type Run = (spec: Record<string, unknown>) => Promise<{ runId: string; routineRunId: string | null }>;
type ActionFn = (a: Record<string, unknown>) => void;
export interface MotionApi { tx: DbTx; bump: Bump; proposal: Proposal; run: Run; action: ActionFn; chat: (channel: string, author: string, text: string, ts: string) => Promise<string> }

async function email(L: MotionApi, to: string, subject: string, body: string, kind: string, ref: string, ts: string) {
  await L.tx.insert(simEmailMessages).values({ id: await newId(L.tx, "eml_"), toAddr: to, fromAddr: "people@larkspur.example", subject, body, kind, relatedRef: ref, ts });
  L.bump("sim_email_messages");
}

/** Offers in every lifecycle state, with their mail and checks; one accepted hire who starts Nov 9. */
async function seedHiring(L: MotionApi, ws: W[]): Promise<string | null> {
  const { tx } = L;
  const imani = "wrk_0004";
  type O = { first: string; last: string; title: string; dept: string; wkp: string; state: string; base: number; start: string; status: string; created: string; sent?: string; viewed?: string; voided?: string; expires?: string; accepted?: string };
  const list: O[] = [
    { first: "Tess", last: "Harlow", title: "Firmware Test Engineer", dept: "dpt_hardware", wkp: "wkp_oakland", state: "CA", base: 13_800_000, start: "2026-12-07", status: "draft", created: pt("2026-10-23", 15) },
    { first: "Marisol", last: "Quint", title: "Field Robotics Technician", dept: "dpt_operations", wkp: "wkp_austin", state: "TX", base: 7_600_000, start: "2026-11-16", status: "viewed", created: pt("2026-10-19", 10), sent: pt("2026-10-19", 11), viewed: pt("2026-10-20", 19), expires: "2026-10-30" },
    { first: "Elias", last: "Brandt", title: "Robotics Integration Engineer", dept: "dpt_hardware", wkp: "wkp_oakland", state: "CA", base: 15_200_000, start: "2026-11-09", status: "accepted", created: pt("2026-10-05", 10), sent: pt("2026-10-05", 11), viewed: pt("2026-10-05", 18), accepted: pt("2026-10-07", 9), expires: "2026-10-12" },
    { first: "Priscilla", last: "Vane", title: "Account Executive", dept: "dpt_gtm", wkp: "wkp_brooklyn", state: "NY", base: 11_000_000, start: "2026-10-19", status: "expired", created: pt("2026-09-21", 10), sent: pt("2026-09-21", 11), expires: "2026-09-28" },
    { first: "Gideon", last: "Achterberg", title: "Mechanical Engineer", dept: "dpt_hardware", wkp: "wkp_oakland", state: "CA", base: 14_600_000, start: "2026-11-02", status: "voided", created: pt("2026-09-28", 10), sent: pt("2026-09-28", 11), voided: pt("2026-10-02", 14), expires: "2026-10-05" },
  ];
  let hireId: string | null = null;
  for (const o of list) {
    const id = await newId(tx, "offr_");
    const mail = `${o.first.toLowerCase()}.${o.last.toLowerCase()}@candidate.example`;
    let workerId: string | null = null;
    if (o.status === "accepted") {
      workerId = await newId(tx, "wrk_");
      hireId = workerId;
      await tx.insert(workers).values({ id: workerId, companyId: CO, employeeNumber: null, type: "employee", workerType: "us_w2", status: "onboarding", firstName: o.first, lastName: o.last,
        personalEmail: mail, workEmail: `${o.first.toLowerCase()}.${o.last.toLowerCase()}@larkspur.example`, title: o.title, departmentId: o.dept, managerId: imani, workplaceId: o.wkp,
        workState: o.state, timezone: "America/Los_Angeles", startDate: o.start, payScheduleId: "ps_us_semimonthly", createdAt: o.accepted!, updatedAt: o.accepted! });
      await tx.insert(payRates).values({ id: await newId(tx, "prt_"), workerId, kind: "salary", amountCents: o.base, effectiveFrom: o.start });
      await tx.insert(taxProfiles).values({ workerId, w4Version: "2020", filingStatus: "single", source: "seed" });
      L.bump("workers");
    }
    // A sent offer reserves the hire's worker id and creates the portal persona (as the offer send does); the worker
    // row exists only once the letter is signed.
    const reserved = workerId ?? (o.status === "viewed" ? await newId(tx, "wrk_") : null);
    if (reserved) {
      await tx.insert(principals).values({ id: await newId(tx, "usr_"), companyId: CO, kind: "human", workerId: reserved, display: `${o.first} ${o.last} (demo)`, email: mail, role: "employee",
        grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "view", it: "none", comms: "none", company: "none" }) });
      L.bump("principals");
    }
    let documentId: string | null = null;
    if (o.status !== "draft") {
      const body = `${DEMO_DOC}\n\nOffer letter: ${o.title}\nLarkspur Robotics (demo)\n${o.first} ${o.last} (demo)\nStart date ${o.start}.`;
      documentId = await newId(tx, "doc_");
      await tx.insert(documents).values({ id: documentId, companyId: CO, workerId: reserved, offerId: id, kind: "offer_letter", title: `Offer letter: ${o.title}`, status: o.status === "accepted" ? "signed" : o.status === "voided" ? "voided" : "sent",
        bodyText: body, sha256: sha256Hex(body), createdAt: o.created, sentAt: o.sent ?? null, signedAt: o.accepted ?? null });
      L.bump("documents");
    }
    await tx.insert(offers).values({ id, companyId: CO, candidateFirst: o.first, candidateLast: o.last, candidateEmail: mail, title: o.title, departmentId: o.dept, workplaceId: o.wkp,
      workState: o.state, managerId: o.dept === "dpt_hardware" ? imani : null, baseCents: o.base, payKind: "salary", startDate: o.start, status: o.status, acceptedAt: o.accepted ?? null,
      workerId, createdAt: o.created, sentAt: o.sent ?? null, viewedAt: o.viewed ?? null, voidedAt: o.voided ?? null, expiresOn: o.expires ?? null, documentId });
    L.bump("offers");
    if (o.sent) await email(L, mail, `Your offer from Larkspur Robotics (demo): ${o.title}`, `Hi ${o.first}, your offer is ready to review and sign in the Weft portal (demo). It expires on ${o.expires}.`, "offer_sent", id, o.sent);
    if (o.accepted) await email(L, mail, "Welcome to Larkspur Robotics (demo)", `Hi ${o.first}, thanks for signing. Your first day is ${o.start}. Your checklist is in the portal (demo).`, "offer_accepted", id, o.accepted);
    if (o.voided) await email(L, mail, "Your Larkspur Robotics (demo) offer was withdrawn", `Hi ${o.first}, the ${o.title} offer was withdrawn after the role was put on hold.`, "offer_voided", id, o.voided);
    if (o.status === "accepted" || o.status === "viewed") {
      const clear = o.status === "accepted";
      await tx.insert(screeningOrders).values({ id: await newId(tx, "scr_"), companyId: CO, offerId: id, workerId, vendor: "checkr", mode: "simulated", packageSlug: "weft_standard_sim", priceCents: 3500,
        phase: "full", status: clear ? "complete" : "pending", result: clear ? "clear" : null, adjudication: clear ? "engaged" : "none", vendorCandidateId: `sim-cand-${id}`, vendorOrderId: `sim-order-${id}`,
        etaOn: clear ? null : "2026-10-29", createdAt: clear ? pt("2026-10-07", 10) : pt("2026-10-21", 10), completedAt: clear ? pt("2026-10-09", 12) : null });
      L.bump("screening_orders");
    }
    L.action({ ts: o.created, actorKind: "human", actorId: "usr_sam", command: "offers.create", args: { offer_id: id }, summary: `Drafted offer ${id} for ${o.first} ${o.last} (demo), ${o.title}`, reversible: "no" });
  }
  // The accepted hire's checklist: five of seven done, bank and I-9 still open.
  if (hireId) {
    for (const [kind, status, owner] of [["sign_offer", "done", "employee"], ["federal_w4", "done", "employee"], ["state_withholding", "done", "employee"], ["direct_deposit", "pending", "employee"],
      ["i9_sim", "pending", "hr"], ["benefits_selection", "done", "employee"], ["it_accounts", "done", "agent"]] as const) {
      await tx.insert(onboardingTasks).values({ id: await newId(tx, "obt_"), workerId: hireId, kind, status, owner, dueOn: "2026-11-09", doneAt: status === "done" ? pt("2026-10-12", 11) : null });
      L.bump("onboarding_tasks");
    }
    const r = await L.run({ at: pt("2026-10-07", 9, 5), trigger: "routine", routineId: "rt_new_hire", triggerRef: `event:offer.accepted:${hireId}`, onBehalfOf: "usr_dana",
      final: `Elias Brandt (demo) accepted. Created accounts, posted the welcome in #new-hires and proposed the laptop order.`,
      tools: [{ name: "it__create_account", args: { worker_id: hireId, system: "google_ws" }, data: { created: true } }, { name: "it__order_device", args: { worker_id: hireId }, data: { proposed: true } }],
      checklist: [{ id: "accounts", label: "create accounts", passed: true }, { id: "device", label: "propose the laptop", passed: true }] });
    await L.proposal({ at: pt("2026-10-07", 9, 6), command: "it.order_device", args: { worker_id: hireId }, subjectRef: hireId, risk: "R2", domain: "it", moneyCents: 189_900, status: "pending",
      headline: `Order Larkspur standard laptop (sim) for Elias Brandt (demo) (${hireId}) at $1,899.00`, runId: r.runId, routineRunId: r.routineRunId, expiresAt: "2026-11-02T17:00:00.000Z",
      diff: [{ label: "Device", before: "none", after: "Larkspur standard laptop (sim)" }, { label: "Ship to", before: "", after: "Oakland office" }], evidence: [{ label: "Offer accepted", ref: hireId }] });
  }
  // The submit for this payroll, proposed by Friday's pre-payroll review and waiting for Theo.
  const [draft] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, "pay_2026_10_30"));
  if (draft && draft.status === "draft") {
    const t = JSON.parse(draft.totalsJson ?? "{}") as Record<string, number>;
    const cost = t.totalCostCents ?? t.employerCostCents ?? null;
    const r = await L.run({ at: pt("2026-10-23", 9), trigger: "routine", routineId: "rt_pre_payroll", onBehalfOf: "usr_theo",
      final: "Reviewed pay_2026_10_30: four paychecks flagged with explanations, Mira Delgado (demo) excluded until her bank account is on file. Proposed the submit.",
      tools: [{ name: "payroll__get_run", args: { run_id: draft.id }, data: { id: draft.id, status: "draft" } }, { name: "payroll__submit_run", args: { run_id: draft.id, exclude_blocked: true }, data: { proposed: true } }],
      checklist: [{ id: "explain", label: "explain flagged paychecks", passed: true }, { id: "submit", label: "propose payroll.submit_run", passed: true }] });
    await L.proposal({ at: pt("2026-10-23", 9, 1), command: "payroll.submit_run", args: { run_id: draft.id, exclude_blocked: true }, subjectRef: draft.id, risk: "R4", domain: "payroll", moneyCents: cost ?? undefined,
      status: "pending", headline: `Submit payroll ${draft.id} (${draft.periodStart} to ${draft.periodEnd}, payday ${draft.payday})`, runId: r.runId, routineRunId: r.routineRunId,
      expiresAt: draft.approvalDeadline, onBehalfOf: "usr_theo", evidence: [{ label: "Pay run", ref: draft.id }, { label: "Excluded worker", ref: "wrk_0022" }],
      diff: [{ label: "Status", before: "draft", after: "processing" }, { label: "Excluded (blocked)", before: "none", after: "Mira Delgado (demo) (wrk_0022)" }] });
  }
  void ws;
  return hireId;
}

/** Paid claims from January to September, reimbursed on the previous provider's payroll (imported). */
async function seedExpenseHistory(L: MotionApi, ws: W[]): Promise<void> {
  const emp = ws.filter((w) => w.type === "employee" && w.status === "active" && w.startDate < "2026-01-01");
  const claims: [string, string, number, string, string, number | null][] = [
    ["travel", "Bayline Air (demo)", 38_420, "2026-01-21", "Customer visit in Austin", null], ["meals", "Harbor Noodle Bar (demo)", 6_480, "2026-02-04", "Team lunch with a prospect", null],
    ["mileage", "Mileage", 4_221, "2026-02-18", "Drive to the Austin Yard test site", 603], ["software", "Sketchwell (demo)", 4_800, "2026-03-02", "Design tool seat", null],
    ["travel", "Cedar Rail (demo)", 12_900, "2026-03-19", "Train to the Brooklyn studio", null], ["meals", "Lantern Diner (demo)", 5_210, "2026-04-08", "Recruiting dinner", null],
    ["lodging", "Pinecrest Inn (demo)", 31_600, "2026-04-22", "Two nights for the trade show", null], ["mileage", "Mileage", 2_744, "2026-05-06", "Supplier visit in Fremont", 392],
    ["software", "Fleetlog Cloud (demo)", 4_900, "2026-05-27", "Fleet log analysis seat", null], ["travel", "Bayline Air (demo)", 41_250, "2026-06-10", "Field trial in Austin", null],
    ["meals", "Harbor Noodle Bar (demo)", 7_120, "2026-06-24", "Onboarding lunch", null], ["lodging", "Pinecrest Inn (demo)", 17_800, "2026-07-15", "Night before the site install", null],
    ["mileage", "Mileage", 5_740, "2026-08-05", "Drives between Oakland and the warehouse", 820], ["software", "Sketchwell (demo)", 4_800, "2026-08-12", "Design tool seat", null],
    ["travel", "Cedar Rail (demo)", 9_800, "2026-09-02", "Train to the customer review", null], ["meals", "Lantern Diner (demo)", 6_900, "2026-09-16", "Dinner with the integration partner", null],
    ["travel", "Bayline Air (demo)", 29_300, "2026-04-02", "Conference travel, submitted after 60 days", null], ["meals", "Harbor Noodle Bar (demo)", 4_100, "2026-07-01", "Working lunch", null],
  ];
  for (const [i, [category, merchant, cents, date, purpose, miles]] of claims.entries()) {
    const w = emp[(i * 7) % emp.length]!;
    const late = purpose.includes("after 60 days");
    const submitted = late ? "2026-06-15" : new Date(Date.parse(`${date}T12:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    const decided = new Date(Date.parse(`${submitted}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
    const id = await newId(L.tx, "exp_");
    await L.tx.insert(expenses).values({ id, companyId: CO, workerId: w.id, category, merchant, amountCents: cents, transactionDate: date, submittedAt: pt(submitted, 9), businessPurpose: purpose,
      milesX10: miles, receiptExtractJson: miles ? null : JSON.stringify({ merchant, date, total_cents: cents, source: "simulated extractor (sidecar)" }), status: "paid",
      checksJson: late ? JSON.stringify([{ rule: "OVER_ACCOUNTABLE_WINDOW", severity: "review", message: "Submitted more than 60 days after the expense, so it is paid as taxable wages", evidence: [{ label: "Expense", ref: id }] }]) : "[]",
      approverPrincipalId: "usr_dana", decidedBy: "usr_dana", decidedAt: pt(decided, 11), decisionReasonCode: late ? "taxable_late" : null,
      decisionNote: late ? "Paid as taxable wages (accountable plan window passed). Reimbursed on the previous provider's payroll." : "Reimbursed on the previous provider's payroll.", policyVersion: 1, source: i % 5 === 0 ? "email" : "portal" });
    L.action({ ts: pt(decided, 11), actorKind: "human", actorId: "usr_dana", command: "expenses.decide", args: { expense_id: id, decision: late ? "approve_taxable" : "approve" }, summary: `Approved expense ${id} for ${w.firstName} ${w.lastName} (demo)${late ? " as taxable wages" : ""}`, reversible: "no" });
    L.bump("expenses");
  }
}

/** Two earlier Greenhouse deliveries that became draft offers, and one resolved and one open sync item. */
async function seedIntegrations(L: MotionApi): Promise<void> {
  const { tx } = L;
  const offs = await tx.select().from(offers).orderBy(asc(offers.id));
  const linked = offs.filter((o) => ["Tess", "Marisol"].includes(o.candidateFirst));
  for (const [i, o] of linked.entries()) {
    const key = `gh-hire-${6600090 + i}`;
    await tx.insert(integrationDeliveries).values({ id: await newId(tx, "dlv_"), vendor: "greenhouse", dedupeKey: key, action: "candidate_hired", receivedAt: o.createdAt ?? pt("2026-10-19", 10),
      verified: true, rawSha256: createHash("sha256").update(key).digest("hex"), appliedAt: o.createdAt ?? pt("2026-10-19", 10), error: null });
    await tx.insert(extLinks).values({ id: await newId(tx, "extl_"), companyId: CO, vendor: "greenhouse", extType: "application", extId: String(6600090 + i), weftType: "offer", weftId: o.id,
      extVersion: 1, status: "linked", createdAt: o.createdAt ?? pt("2026-10-19", 10), updatedAt: o.createdAt ?? pt("2026-10-19", 10) });
    L.bump("integration_deliveries");
  }
  await tx.insert(syncItems).values({ id: await newId(tx, "syn_"), companyId: CO, vendor: "greenhouse", kind: "unmapped_value", subjectRef: linked[0]?.id ?? "offr_0001", status: "resolved",
    detailJson: JSON.stringify({ field: "office", value: "Austin Yard", note: "Mapped the Greenhouse office to Austin Yard (demo)" }), createdAt: pt("2026-10-19", 10), resolvedAt: pt("2026-10-19", 14), resolvedBy: "usr_sam" });
  await tx.insert(syncItems).values({ id: await newId(tx, "syn_"), companyId: CO, vendor: "greenhouse", kind: "sync_conflict", subjectRef: linked[1]?.id ?? "offr_0001", status: "open",
    detailJson: JSON.stringify({ field: "start_date", weft: "2026-11-16", vendor: "2026-11-23", note: "Greenhouse changed the start date after the offer was drafted in Weft" }), createdAt: pt("2026-10-22", 16), resolvedAt: null, resolvedBy: null });
  L.bump("sync_items", 2);
}

/** August clean (no findings), September with one resolved finding; October stays un-run for the tour. */
async function seedReconciliation(L: MotionApi, ws: W[]): Promise<void> {
  const w = ws.find((x) => x.id === "wrk_0017");
  await L.tx.insert(benefitReconFindings).values({ id: await newId(L.tx, "rcf_"), companyId: CO, month: "2026-09", carrier: "Juniper Mutual (sim)", kind: "wrong_tier", workerId: w?.id ?? null, planId: null,
    billedCents: 98_400, expectedCents: 61_200, deductedCents: 61_200, status: "resolved", detail: "Billed at family tier after a tier change to employee and spouse; the carrier credited the difference on the October invoice.", createdAt: "2026-10-02T17:00:00.000Z" });
  L.bump("benefit_recon_findings");
}

/** Device orders for the 2026 hires, one in transit, and the contractors' guest accounts, forms and contracts. */
async function seedItAndContractors(L: MotionApi, ws: W[], hireId: string | null): Promise<void> {
  const { tx } = L;
  for (const w of ws.filter((x) => x.type === "employee" && x.startDate >= "2026-01-01")) {
    const shipped = w.id === "wrk_0022";
    await tx.insert(simDeviceOrders).values({ id: await newId(tx, "simd_"), workerId: w.id, sku: "larkspur-standard-laptop", shipTo: "Oakland office (demo)", priceCents: 189_900, status: shipped ? "shipped" : "delivered",
      eta: pt(shipped ? "2026-10-28" : w.startDate, 12), createdAt: pt(new Date(Date.parse(`${w.startDate}T12:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10), 10) });
    L.bump("sim_device_orders");
  }
  for (const w of ws.filter((x) => x.type === "contractor")) {
    const handle = `${w.firstName.toLowerCase()}.${w.lastName.toLowerCase()}.guest`;
    await tx.insert(itAccounts).values({ id: await newId(tx, "ita_"), workerId: w.id, system: "chat", handle, groupsJson: JSON.stringify(["#eng-contractors"]), status: "active" }).onConflictDoNothing();
    await tx.insert(devices).values({ id: await newId(tx, "dev_"), workerId: w.id, model: "Contractor field tablet (sim)", status: "delivered", orderRef: null, priceCents: 64_900 });
    const body = `${DEMO_DOC}\n\nIndependent contractor agreement\nLarkspur Robotics (demo)\n${w.firstName} ${w.lastName} (demo)\nMonthly fee in ${w.currency}, paid on the payment rail.`;
    await tx.insert(documents).values({ id: await newId(tx, "doc_"), companyId: CO, workerId: w.id, offerId: null, kind: "offer_letter", title: "Independent contractor agreement", status: "signed", bodyText: body,
      sha256: sha256Hex(body), createdAt: pt(w.startDate, 9), sentAt: pt(w.startDate, 9), signedAt: pt(w.startDate, 15) });
    L.bump("documents"); L.bump("devices");
  }
  // The accepted hire's accounts are being provisioned ahead of the start date.
  if (hireId) {
    const hire = (await tx.select().from(workers).where(eq(workers.id, hireId)))[0];
    if (hire) {
      const handle = `${hire.firstName.toLowerCase()}.${hire.lastName.toLowerCase()}`;
      for (const [system, status] of [["google_ws", "active"], ["chat", "active"], ["github", "provisioning"]] as const) {
        await tx.insert(itAccounts).values({ id: await newId(tx, "ita_"), workerId: hireId, system, handle: system === "github" ? `lrk-${handle.replace(".", "-")}` : handle, groupsJson: JSON.stringify(system === "chat" ? ["#new-hires", "#hardware"] : []), status }).onConflictDoNothing();
        L.bump("it_accounts");
      }
    }
  }
  // New-hire benefits election windows: Mira's is open now, Elias's opens on his first day.
  for (const [wid, opens, closes, status] of [["wrk_0022", "2026-10-19", "2026-11-18", "open"], [hireId, "2026-11-09", "2026-12-09", "scheduled"]] as const) {
    if (!wid) continue;
    await tx.insert(enrollmentWindows).values({ id: await newId(tx, "ewn_"), companyId: CO, workerId: wid, kind: "new_hire", lifeEventId: null, opensOn: opens, closesOn: closes, status, remindersSent: status === "open" ? 1 : 0, createdAt: pt(opens, 8) });
    L.bump("enrollment_windows");
  }
  void contractorTaxForms;
}

/** The October expense decisions already on the planted claims, as the proposals Dana approved from a chat review. */
async function seedExpenseDecisions(L: MotionApi, ws: W[]): Promise<void> {
  const decided = (await L.tx.select().from(expenses).orderBy(asc(expenses.id))).filter((e) => (e.status === "approved" || e.status === "declined") && e.decidedAt && e.id <= "exp_0014");
  if (!decided.length) return;
  const first = decided.map((e) => e.decidedAt!).sort()[0]!;
  const at = new Date(Date.parse(first) - 20 * 60_000).toISOString();
  const r = await L.run({ at, trigger: "chat", onBehalfOf: "usr_dana", tools: [{ name: "expenses__list", args: { status: "submitted" }, data: { count: decided.length } }],
    final: `Reviewed ${decided.length} submitted claims against the policy and proposed a decision for each; approvals stay with you.` });
  for (const e of decided) {
    const w = ws.find((x) => x.id === e.workerId);
    const who = w ? `${w.firstName} ${w.lastName} (demo) (${w.id})` : e.workerId;
    const approve = e.status === "approved";
    await L.proposal({ at, command: "expenses.decide", args: { expense_id: e.id, decision: approve ? "approve" : "decline" }, subjectRef: `expense:${e.id}`, risk: "R2", domain: "payroll",
      moneyCents: approve ? e.amountCents : 0, status: "executed", decidedBy: e.decidedBy ?? "usr_dana", decidedAt: e.decidedAt!, runId: r.runId, reversible: true,
      headline: `${approve ? "Approve" : "Decline"} expense ${e.id} for ${who}: $${(e.amountCents / 100).toFixed(2)} ${e.category} on ${e.transactionDate}`,
      diff: [{ label: "Status", before: "needs_review", after: e.status }], evidence: [{ label: "Expense", ref: e.id }],
      exec: { ts: e.decidedAt!, actorKind: "human", actorId: e.decidedBy ?? "usr_dana", summary: `${approve ? "Approved" : "Declined"} expense ${e.id} for ${who}`, reversible: "no" } });
  }
}

export async function seedRichMotion(L: MotionApi, ws: W[]): Promise<void> {
  await seedExpenseDecisions(L, ws);
  const hireId = await seedHiring(L, ws);
  await seedExpenseHistory(L, ws);
  await seedIntegrations(L);
  await seedReconciliation(L, ws);
  await seedItAndContractors(L, ws, hireId);
}
