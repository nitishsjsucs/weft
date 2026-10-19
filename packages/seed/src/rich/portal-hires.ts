// Rich profile, part 5: two more accepted hires, so the portal's "Viewing as" menu has a new hire at each checklist
// stage (Marisol at the offer, Tobias at 2 of 7, Elias at 5 of 7, Odette at 7 of 7 and payroll ready) and Home reads
// "onboarding" for the hires who start in November. Odette (NY) also has a home office claim approved through the
// portal and the New York harassment prevention course the training rules assign a new NY hire within 30 days.
// Same rules as the rest of the rich layer: add rows only, fixed instants, (demo) names, no model calls.
import { and, eq } from "drizzle-orm";
import {
  bankAccounts, devices, documents, expenses, itAccounts, offers, onboardingTasks, payRates, principals, screeningOrders, simEmailMessages, taxProfiles, trainingAssignments,
  trainingCourses, workers, type DbTx,
} from "@weft/db";
import { newId, payroll, sha256Hex } from "@weft/core";
import { receiptUpload } from "./motion";

const CO = "cmp_larkspur";
const pt = (date: string, hour: number, minute = 0) => payroll.ptToUtc(date, hour, minute);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DEMO_DOC = "DEMO DOCUMENT. Fictional company, fictional person, simulated signature. Not a real record.";
const KINDS = ["sign_offer", "sign_confidentiality", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection", "it_accounts"] as const;
const OWNER: Record<string, string> = { i9_sim: "hr", it_accounts: "agent" };

export interface PortalHiresApi { dataDir?: string; tx: DbTx; bump: (table: string, n?: number) => void; action: (a: Record<string, unknown>) => void }

type Hire = {
  first: string; last: string; title: string; dept: string; wkp: string; state: string; tz: string; base: number; start: string; manager: string | null;
  created: string; sent: string; viewed: string; accepted: string; expires: string; done: readonly (typeof KINDS)[number][]; screening: "clear" | "pending";
};

export const PORTAL_HIRES: readonly Hire[] = [
  { first: "Odette", last: "Marsh", title: "Customer Success Manager", dept: "dpt_gtm", wkp: "wkp_brooklyn", state: "NY", tz: "America/New_York", base: 10_400_000, start: "2026-11-02", manager: null,
    created: pt("2026-10-01", 10), sent: pt("2026-10-01", 11), viewed: pt("2026-10-01", 17), accepted: pt("2026-10-02", 9), expires: "2026-10-08", done: KINDS, screening: "clear" },
  { first: "Tobias", last: "Wren", title: "Mechanical Technician", dept: "dpt_hardware", wkp: "wkp_oakland", state: "CA", tz: "America/Los_Angeles", base: 8_800_000, start: "2026-11-30", manager: "wrk_0004",
    created: pt("2026-10-19", 14), sent: pt("2026-10-19", 15), viewed: pt("2026-10-20", 8), accepted: pt("2026-10-21", 10), expires: "2026-10-26", done: ["sign_offer", "federal_w4"], screening: "pending" },
];

async function email(L: PortalHiresApi, to: string, subject: string, body: string, kind: string, ref: string, ts: string) {
  await L.tx.insert(simEmailMessages).values({ id: await newId(L.tx, "eml_"), toAddr: to, fromAddr: "people@larkspur.example", subject, body, kind, relatedRef: ref, ts });
  L.bump("sim_email_messages");
}

async function doc(L: PortalHiresApi, workerId: string, offerId: string | null, kind: string, title: string, who: string, at: string): Promise<string> {
  const body = `${DEMO_DOC}\n\n${title}\nLarkspur Robotics (demo)\n${who}\nSigned ${at.slice(0, 10)}.`;
  const id = await newId(L.tx, "doc_");
  await L.tx.insert(documents).values({ id, companyId: CO, workerId, offerId, kind, title, status: "signed", bodyText: body, sha256: sha256Hex(body), createdAt: at, sentAt: at, signedAt: at });
  L.bump("documents");
  return id;
}

export async function seedPortalHires(L: PortalHiresApi): Promise<string[]> {
  const { tx } = L;
  const made: string[] = [];
  for (const h of PORTAL_HIRES) {
    const who = `${h.first} ${h.last} (demo)`;
    const login = `${h.first.toLowerCase()}.${h.last.toLowerCase()}`;
    const mail = `${login}@candidate.example`;
    const offerId = await newId(tx, "offr_");
    const workerId = await newId(tx, "wrk_");
    made.push(workerId);
    await tx.insert(workers).values({ id: workerId, companyId: CO, employeeNumber: null, type: "employee", workerType: "us_w2", status: "onboarding", firstName: h.first, lastName: h.last,
      personalEmail: mail, workEmail: `${login}@larkspur.example`, title: h.title, departmentId: h.dept, managerId: h.manager, workplaceId: h.wkp, workState: h.state, timezone: h.tz,
      startDate: h.start, payScheduleId: "ps_us_semimonthly", createdAt: h.accepted, updatedAt: h.accepted });
    await tx.insert(payRates).values({ id: await newId(tx, "prt_"), workerId, kind: "salary", amountCents: h.base, effectiveFrom: h.start });
    await tx.insert(taxProfiles).values({ workerId, w4Version: "2020", filingStatus: "single", source: "seed" });
    await tx.insert(principals).values({ id: await newId(tx, "usr_"), companyId: CO, kind: "human", workerId, display: who, email: mail, role: "employee",
      grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "view", it: "none", comms: "none", company: "none" }) });
    L.bump("workers"); L.bump("principals");
    const offerDoc = await doc(L, workerId, offerId, "offer_letter", `Offer letter: ${h.title}`, who, h.accepted);
    await tx.insert(offers).values({ id: offerId, companyId: CO, candidateFirst: h.first, candidateLast: h.last, candidateEmail: mail, title: h.title, departmentId: h.dept, workplaceId: h.wkp,
      workState: h.state, managerId: h.manager, baseCents: h.base, payKind: "salary", startDate: h.start, status: "accepted", acceptedAt: h.accepted, workerId,
      createdAt: h.created, sentAt: h.sent, viewedAt: h.viewed, voidedAt: null, expiresOn: h.expires, documentId: offerDoc });
    L.bump("offers");
    await email(L, mail, `Your offer from Larkspur Robotics (demo): ${h.title}`, `Hi ${h.first}, your offer is ready to review and sign in the Weft portal (demo). It expires on ${h.expires}.`, "offer_sent", offerId, h.sent);
    await email(L, mail, "Welcome to Larkspur Robotics (demo)", `Hi ${h.first}, thanks for signing. Your first day is ${h.start}. Your checklist is in the portal (demo).`, "offer_accepted", offerId, h.accepted);
    const clear = h.screening === "clear";
    await tx.insert(screeningOrders).values({ id: await newId(tx, "scr_"), companyId: CO, offerId, workerId, vendor: "checkr", mode: "simulated", packageSlug: "weft_standard_sim", priceCents: 3500,
      phase: "full", status: clear ? "complete" : "pending", result: clear ? "clear" : null, adjudication: clear ? "engaged" : "none", vendorCandidateId: `sim-cand-${offerId}`, vendorOrderId: `sim-order-${offerId}`,
      etaOn: clear ? null : "2026-10-30", createdAt: pt(addDays(h.accepted.slice(0, 10), 1), 10), completedAt: clear ? pt(addDays(h.accepted.slice(0, 10), 3), 12) : null });
    L.bump("screening_orders");
    // The checklist at its stage, with the records each finished step leaves behind.
    for (const [i, k] of KINDS.entries()) {
      const done = h.done.includes(k);
      const at = pt(addDays(h.accepted.slice(0, 10), Math.min(i, 5)), 11);
      await tx.insert(onboardingTasks).values({ id: await newId(tx, "obt_"), workerId, kind: k, status: done ? "done" : "pending", owner: OWNER[k] ?? "employee", dueOn: h.start, doneAt: done ? at : null });
      L.bump("onboarding_tasks");
      if (!done) continue;
      if (k === "sign_confidentiality") await doc(L, workerId, null, "confidentiality_agreement", "Confidentiality and invention assignment agreement", who, at);
      if (k === "federal_w4") await doc(L, workerId, null, "w4", "Form W-4, employee's withholding certificate", who, at);
      if (k === "state_withholding" && h.state === "NY") await doc(L, workerId, null, "state_withholding", "IT-2104: New York employee withholding certificate", who, at);
      if (k === "i9_sim") await doc(L, workerId, null, "i9", "Form I-9 receipt (masked)", who, at);
      if (k === "direct_deposit") {
        await tx.insert(bankAccounts).values({ id: await newId(tx, "bnk_"), workerId, bankName: "Sim Federal Credit Union", accountLast4: "4417", routingLast4: "0213", credentialRef: `vault:bank-${workerId}`, status: "active", source: "portal" });
        L.bump("bank_accounts");
      }
      if (k === "it_accounts") {
        for (const system of ["google_ws", "chat"] as const) {
          await tx.insert(itAccounts).values({ id: await newId(tx, "ita_"), workerId, system, handle: login, groupsJson: JSON.stringify(system === "chat" ? ["#new-hires", "#gtm"] : []), status: "active" }).onConflictDoNothing();
          L.bump("it_accounts");
        }
      }
    }
    // Hardware before day one: Odette's laptop has arrived, Tobias's workstation is on order.
    const [model, status, price] = h.dept === "dpt_hardware" ? ["Engineering workstation (sim)", "ordered", 324_900] as const : ["Larkspur standard laptop (sim)", "delivered", 189_900] as const;
    await tx.insert(devices).values({ id: await newId(tx, "dev_"), workerId, model, status, orderRef: null, priceCents: price });
    L.bump("devices");
    L.action({ ts: h.created, actorKind: "human", actorId: "usr_sam", command: "offers.create", args: { offer_id: offerId }, summary: `Drafted offer ${offerId} for ${who}, ${h.title}`, reversible: "no" });
    L.action({ ts: h.accepted, actorKind: "human", actorId: "usr_sam", command: "people.create_worker", args: { worker_id: workerId }, summary: `Added ${who} (${workerId}) as ${h.title}, starting ${h.start}`, reversible: "no" });
  }
  // Odette: a home office claim she submitted from the portal (approved, it pays with her first paycheck), and the
  // New York course a new NY hire must finish within 30 days of starting.
  const odette = made[0]!;
  const exp = await newId(tx, "exp_");
  // Her receipt is on file (equipment over $75 needs one). The claim predates her start date, which the policy engine
  // flags as outside employment, so no checks are stored for it here (see docs/tracks/rich-seed.md, known gaps).
  const extract = { merchant: "Deskline Supply (demo)", date: "2026-10-20", total_cents: 18_640, source: "simulated extractor (sidecar)" };
  const receiptUploadId = await receiptUpload(L, odette, exp, 900, pt("2026-10-21", 18), JSON.stringify(extract));
  await tx.insert(expenses).values({ id: exp, companyId: CO, workerId: odette, category: "equipment", merchant: "Deskline Supply (demo)", amountCents: 18_640, transactionDate: "2026-10-20",
    submittedAt: pt("2026-10-21", 18), businessPurpose: "Monitor arm and keyboard for the home office, under the remote work policy",
    receiptUploadId, receiptExtractJson: JSON.stringify(extract), status: "approved", checksJson: "[]",
    approverPrincipalId: "usr_dana", decidedBy: "usr_dana", decidedAt: pt("2026-10-22", 10), decisionNote: "Approved. It pays with the first regular paycheck after the start date.", policyVersion: 1, source: "portal" });
  L.bump("expenses");
  L.action({ ts: pt("2026-10-22", 10), actorKind: "human", actorId: "usr_dana", command: "expenses.decide", args: { expense_id: exp, decision: "approve" }, summary: `Approved expense ${exp} for Odette Marsh (demo)`, reversible: "no" });
  const [ny] = await tx.select().from(trainingCourses).where(and(eq(trainingCourses.companyId, CO), eq(trainingCourses.code, "ny_harassment")));
  if (ny) {
    await tx.insert(trainingAssignments).values({ id: await newId(tx, "tra_"), workerId: odette, courseId: ny.id, dueOn: addDays("2026-11-02", ny.dueWithinDays), status: "assigned", assignedAt: pt("2026-10-23", 9) });
    L.bump("training_assignments");
  }
  return made;
}
