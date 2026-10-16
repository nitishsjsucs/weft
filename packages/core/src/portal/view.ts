// GET /v1/portal/me: the persona's checklist (PortalView plus what each portal screen renders).
import { and, desc, eq } from "drizzle-orm";
import { PORTAL_TASK_ORDER, STATE_WITHHOLDING_FORMS, type PortalTaskKind, type W2OnboardingPortalView } from "@weft/contracts";
import { bankAccounts, benefitPlans, documents, onboardingTasks, taxProfiles, uploads, workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";
import { maskedUpload, portalKindsFor } from "./forms";
import { legalName, loadPersona } from "./persona";

export const PORTAL_TASK_TITLES: Record<PortalTaskKind, string> = {
  sign_offer: "Sign your offer letter",
  sign_confidentiality: "Sign the confidentiality agreement",
  federal_w4: "Federal tax withholding (Form W-4)",
  state_withholding: "State tax withholding",
  direct_deposit: "Direct deposit",
  i9_sim: "Employment eligibility (I-9)",
  benefits_selection: "Choose your benefits",
};
const TASK_DOC: Partial<Record<PortalTaskKind, string>> = {
  sign_offer: "offer_letter", sign_confidentiality: "confidentiality_agreement", federal_w4: "w4", state_withholding: "state_withholding",
  direct_deposit: "direct_deposit_auth", i9_sim: "i9", benefits_selection: "benefits_election",
};

export async function portalView(tx: DbTx, companyId: string, principalId: string): Promise<W2OnboardingPortalView | null> {
  const p = await loadPersona(tx, companyId, principalId);
  if (!p) return null;
  const o = p.offer;
  const [w] = await tx.select().from(workers).where(eq(workers.id, p.workerId)).limit(1);
  const docs = await tx.select().from(documents).where(and(eq(documents.companyId, companyId), eq(documents.workerId, p.workerId)));
  const rows = w ? await tx.select().from(onboardingTasks).where(eq(onboardingTasks.workerId, w.id)) : [];
  const kinds = portalKindsFor(o.workState);
  const accepted = o.status === "accepted";
  const tasks = kinds.map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    const doc = docs.filter((d) => d.kind === TASK_DOC[kind] && d.status !== "voided").sort((a, b) => (a.id < b.id ? 1 : -1))[0] ?? null;
    const status: "pending" | "done" | "blocked" = row ? (row.status === "done" ? "done" : "pending") : kind === "sign_offer" && (o.status === "sent" || o.status === "viewed") ? "pending" : "blocked";
    return { kind, title: PORTAL_TASK_TITLES[kind], status, doneAt: row?.doneAt ?? null, documentId: doc?.id ?? null };
  });
  tasks.sort((a, b) => PORTAL_TASK_ORDER.indexOf(a.kind) - PORTAL_TASK_ORDER.indexOf(b.kind));
  const done = tasks.filter((t) => t.status === "done").length;
  const plans = await tx.select().from(benefitPlans).where(eq(benefitPlans.companyId, companyId));
  const [bank] = w ? await tx.select().from(bankAccounts).where(and(eq(bankAccounts.workerId, w.id), eq(bankAccounts.status, "active"))).orderBy(desc(bankAccounts.id)).limit(1) : [];
  const [profile] = w ? await tx.select().from(taxProfiles).where(eq(taxProfiles.workerId, w.id)).limit(1) : [];
  const [upload] = w ? await tx.select().from(uploads).where(and(eq(uploads.workerId, w.id), eq(uploads.purpose, "i9_id_image"))).orderBy(desc(uploads.id)).limit(1) : [];
  return {
    worker: { id: p.workerId, displayName: displayName(o.candidateFirst, o.candidateLast), title: o.title, workState: o.workState, startDate: o.startDate },
    offerId: o.id, tasks, done, total: tasks.length,
    payrollReady: accepted && ["federal_w4", "direct_deposit"].every((k) => tasks.find((t) => t.kind === k)?.status === "done"),
    offer: { id: o.id, status: o.status as never, title: o.title, baseCents: o.baseCents, payKind: o.payKind, startDate: o.startDate, expiresOn: o.expiresOn, candidateEmail: o.candidateEmail },
    signer: { principalId: p.principal.id, legalName: legalName(o) },
    documents: docs.filter((d) => d.kind === "offer_letter" || d.kind === "confidentiality_agreement").sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((d) => ({ id: d.id, kind: d.kind as never, title: d.title, status: d.status as never, sha256: d.sha256, bodyText: d.bodyText, signedAt: d.signedAt })),
    stateForm: STATE_WITHHOLDING_FORMS[o.workState] ?? null,
    plans: plans.filter((pl) => pl.type !== "hsa").map((pl) => {
      const prices = JSON.parse(pl.pricesJson) as Record<string, number>;
      const match = pl.matchJson ? JSON.parse(pl.matchJson) as { min_deferral_bps?: number; max_deferral_bps?: number } : null;
      const tierPrices = Object.fromEntries(Object.entries(prices).filter(([k]) => ["ee", "ee_spouse", "ee_children", "family"].includes(k)));
      return { id: pl.id, type: pl.type, name: pl.name, carrier: pl.carrier, tierPrices, deferral: pl.type === "401k" ? { minBps: match?.min_deferral_bps ?? 0, maxBps: match?.max_deferral_bps ?? 10_000 } : null };
    }),
    bank: bank ? { bankName: bank.bankName, routingLast4: bank.routingLast4, accountLast4: bank.accountLast4, status: bank.status } : null,
    w4: profile ? { filingStatus: profile.filingStatus, source: profile.source } : null,
    upload: upload ? maskedUpload(upload) : null,
    workerStatus: w?.status ?? null,
  };
}
