// rt_memory_digest's deterministic step (harness 18 items 1 to 3): structured DB rows become dossier facts (each
// dated and sourced, no pay amounts, no free text from untrusted sources), the executor's memory store coarsens the
// timeline and writes everything in one commit as Weft Agent, and the dossiers table indexes what was written.
import { and, eq, inArray } from "drizzle-orm";
import { companies, departments, dossiers, notices, payrollRuns, principals, proposals, routines, taxAccounts, workers, type Db } from "@weft/db";
import type { MemoryFrontmatter, MemoryHit, MemoryStore } from "@weft/contracts";

// Structural mirror of the executor's LocalMemory additions (packages/executor/src/memory/store.ts); the executor
// index exports only the frozen MemoryStore type, so apps/api names the shape it uses here.
export interface DigestFact { text: string; date: string; src: string; tainted?: boolean }
export interface DigestSources {
  people: { id: string; name: string; aliases: string[]; facts: DigestFact[] }[];
  states: { code: string; facts: DigestFact[] }[];
  agencies: { id: string; path: string; name: string; aliases: string[]; facts: DigestFact[] }[];
  notices: { id: string; facts: DigestFact[] }[];
  onePager: { companyName: string; asOf: string; headcount: DigestFact[]; openItems: DigestFact[]; workstreams: DigestFact[]; autonomy: DigestFact[] } | null;
  decisions?: { deciderId: string; deciderName: string; kind: string; outcome: "approved" | "denied" | "edited" | "dismissed"; reasonCode: string | null; decidedAt: string; proposalId: string }[];
}
export interface DigestOutcome {
  commit: string | null; key: string; periods: string[]; removed: string[]; written: string[];
  dossiers: { subjectRef: string; path: string; sourceDigest: string }[]; skipped: { path: string; reason: string }[];
}
export interface MemoryW2 extends MemoryStore {
  root(): string | null;
  digest(input: { now: string; sources: DigestSources; companyRef: string; windowDays?: number }): Promise<DigestOutcome>;
  links(path: string): Promise<{ outgoing: { target: string; path: string; resolved: boolean }[]; backlinks: string[] }>;
  aliasIndex(): Promise<{ path: string; id: string; aliases: string[] }[]>;
  history(path: string, limit?: number): Promise<{ commit: string; date: string; author: string; subject: string; diff: string }[]>;
  recall(input: { request: string; subjectRefs: string[]; trustedOnly?: boolean }): Promise<{ block: string; items: { path: string; kind: string; taintedBy: string | null }[]; searches: string[] }>;
  read(path: string, at?: string): Promise<{ frontmatter: MemoryFrontmatter; body: string } | null>;
  search(q: { query: string; folders: null | ("entities" | "comms" | "timeline" | "workstreams" | "knowledge")[]; at: string | null; limit: number }): Promise<MemoryHit[]>;
}

const day = (iso: string | null | undefined, fallback: string) => (iso ? iso.slice(0, 10) : fallback);
const maxDay = (days: string[], fallback: string) => days.sort().at(-1) ?? fallback;
const mask = (s: string | null) => (s ? `${"*".repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : "not registered");
const OPEN_NOTICE = ["new", "in_review", "proposed"];

/** Dossier and one-pager inputs from structured rows only. Notice titles and bodies never enter (untrusted). */
export async function digestSources(db: Db, companyId: string, now: string, workstreamFiles: { path: string; title: string; updated: string }[]): Promise<DigestSources> {
  const today = now.slice(0, 10);
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const ws = await db.select().from(workers).where(eq(workers.companyId, companyId));
  const depts = new Map((await db.select().from(departments).where(eq(departments.companyId, companyId))).map((d) => [d.id, d.name]));
  const accounts = await db.select().from(taxAccounts).where(eq(taxAccounts.companyId, companyId));
  const ns = await db.select({ id: notices.id, agency: notices.agency, kind: notices.kind, formCode: notices.formCode, status: notices.status, receivedAt: notices.receivedAt, respondBy: notices.respondBy, taxAccountId: notices.taxAccountId })
    .from(notices).where(eq(notices.companyId, companyId));
  const pending = await db.select().from(proposals).where(and(eq(proposals.companyId, companyId), eq(proposals.status, "pending")));
  const drafts = await db.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), inArray(payrollRuns.status, ["draft"])));
  const rts = await db.select({ id: routines.id, name: routines.name, enabled: routines.enabled, autonomy: routines.autonomy, createdAt: routines.createdAt, taintedBy: routines.taintedBy }).from(routines).where(eq(routines.companyId, companyId));
  const fallback = day(c?.createdAt, today);

  const people = ws.map((w) => {
    const d = day(w.updatedAt, fallback), src = `worker:${w.id}`;
    const facts: DigestFact[] = [
      { text: `Title ${w.title}`, date: d, src },
      { text: `Status ${w.status}`, date: d, src },
      { text: `Work state ${w.workState ?? "none"}`, date: d, src },
      { text: `Start date ${w.startDate}`, date: d, src },
      ...(w.endDate ? [{ text: `End date ${w.endDate}`, date: d, src }] : []),
      { text: `Worker type ${w.workerType}`, date: d, src },
      ...(w.departmentId && depts.get(w.departmentId) ? [{ text: `Department ${depts.get(w.departmentId)}`, date: d, src }] : []),
      ...(w.managerId ? [{ text: `Manager ${w.managerId}`, date: d, src }] : []),
    ];
    return { id: w.id, name: `${w.firstName} ${w.lastName}`, aliases: [`${w.firstName} ${w.lastName}`, ...(w.preferredName ? [`${w.preferredName} ${w.lastName}`] : [])], facts };
  });

  const stateCodes = [...new Set([...ws.filter((w) => w.workState && w.status !== "terminated").map((w) => w.workState!), ...accounts.map((a) => a.jurisdiction).filter((j) => /^[A-Z]{2}$/.test(j))])].sort();
  const states = stateCodes.map((code) => {
    const inState = ws.filter((w) => w.workState === code);
    const active = inState.filter((w) => w.status === "active"), onboarding = inState.filter((w) => w.status === "onboarding");
    const d = maxDay(inState.map((w) => day(w.updatedAt, fallback)), fallback);
    const facts: DigestFact[] = [
      { text: `Active employees ${active.length}`, date: d, src: `workers:state=${code}` },
      ...(onboarding.length ? [{ text: `Onboarding ${onboarding.length}`, date: d, src: `workers:state=${code}` }] : []),
      ...accounts.filter((a) => a.jurisdiction === code).map((a) => ({ text: `Agency account ${a.agency} ${a.accountType} status ${a.status}`, date: day(a.registeredAt, fallback), src: `tax_account:${a.id}` })),
    ];
    return { code, facts };
  });

  const agencies = accounts.map((a) => {
    const d = day(a.registeredAt, fallback), src = `tax_account:${a.id}`;
    const open = ns.filter((n) => n.taxAccountId === a.id && OPEN_NOTICE.includes(n.status));
    const facts: DigestFact[] = [
      { text: `Jurisdiction ${a.jurisdiction}`, date: d, src },
      { text: `Status ${a.status}`, date: d, src },
      { text: `Account ${mask(a.accountNumber)}`, date: d, src },
      ...(a.depositSchedule ? [{ text: `Deposit schedule ${a.depositSchedule}`, date: d, src }] : []),
      ...open.map((n) => ({ text: `Open notice ${n.id} (${n.kind})`, date: day(n.receivedAt, d), src: `notice:${n.id}` })),
    ];
    return { id: a.id, path: `entities/agencies/${a.agency}-${a.accountType}.md`, name: `${a.agency} ${a.accountType}`, aliases: [a.agency], facts };
  });

  const noticeDocs = ns.map((n) => {
    const d = day(n.receivedAt, fallback), src = `notice:${n.id}`;
    return { id: n.id, facts: [
      { text: `Agency ${n.agency}`, date: d, src }, { text: `Kind ${n.kind}`, date: d, src }, { text: `Form ${n.formCode}`, date: d, src },
      { text: `Status ${n.status}`, date: d, src }, ...(n.respondBy ? [{ text: `Respond by ${n.respondBy}`, date: d, src }] : []),
    ] };
  });

  const headcount: DigestFact[] = stateCodes.map((code) => {
    const inState = ws.filter((w) => w.workState === code);
    const active = inState.filter((w) => w.status === "active").length, onboarding = inState.filter((w) => w.status === "onboarding").length;
    return { text: `${code} ${active} active${onboarding ? `, ${onboarding} onboarding` : ""}`, date: maxDay(inState.map((w) => day(w.updatedAt, fallback)), fallback), src: `workers:state=${code}` };
  }).filter((f) => !/^\w\w 0 active$/.test(f.text));
  const openItems: DigestFact[] = [
    ...drafts.map((r) => ({ text: `Payroll draft ${r.id} payday ${r.payday}, approve by ${r.approvalDeadline}`, date: day(r.createdAt, fallback), src: `payroll_run:${r.id}` })),
    ...ns.filter((n) => OPEN_NOTICE.includes(n.status)).map((n) => ({ text: `Notice ${n.id} ${n.kind} from ${n.agency}${n.respondBy ? `, respond by ${n.respondBy}` : ""}`, date: day(n.receivedAt, fallback), src: `notice:${n.id}` })),
    // A proposal from a run that read untrusted content keeps its headline out of the one-pager.
    ...pending.map((p) => ({ text: `Pending approval ${p.id}: ${p.headline}`, date: day(p.createdAt, fallback), src: `proposal:${p.id}`, tainted: p.taintedBy !== null })),
  ];
  const workstreams: DigestFact[] = workstreamFiles.map((f) => ({ text: `${f.title} (${f.path})`, date: f.updated || fallback, src: f.path }));
  const autonomy: DigestFact[] = rts.filter((r) => !r.taintedBy).sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({ text: `Routine ${r.id} ${r.enabled ? "enabled" : "disabled"}, autonomy ${r.autonomy}`, date: day(r.createdAt, fallback), src: `routine:${r.id}` }));
  autonomy.push({ text: "Every change to pay, tax and benefits data is a proposal a person approves (knowledge/preferences/agent/autonomy.md)", date: fallback, src: "knowledge/preferences/agent/autonomy.md" });
  const all = [...headcount, ...openItems, ...workstreams, ...autonomy].filter((f) => !f.tainted);
  // Learned preferences: decided proposals by decider and kind, with the structured reason code only.
  const names = new Map((await db.select({ id: principals.id, display: principals.display }).from(principals).where(eq(principals.companyId, companyId))).map((p) => [p.id, p.display]));
  type Outcome = "approved" | "denied" | "edited" | "dismissed";
  const outcome = (status: string): Outcome | null => (["approved", "executed", "failed"].includes(status) ? "approved" : status === "denied" ? "denied" : status === "superseded" ? "edited" : status === "dismissed" ? "dismissed" : null);
  const decided = (await db.select().from(proposals).where(eq(proposals.companyId, companyId)))
    .filter((p) => p.decidedBy && p.decidedAt && outcome(p.status))
    .map((p) => ({ deciderId: p.decidedBy!, deciderName: names.get(p.decidedBy!) ?? p.decidedBy!, kind: p.command ?? p.kind, outcome: outcome(p.status)!, reasonCode: p.decisionCode, decidedAt: p.decidedAt!, proposalId: p.id }));
  return {
    people, states, agencies, notices: noticeDocs, decisions: decided,
    onePager: { companyName: c?.legalName ?? companyId, asOf: maxDay(all.map((f) => f.date), fallback), headcount, openItems, workstreams, autonomy },
  };
}

export interface DigestRun extends DigestOutcome { summary: string }

/** The digest for one company at `now`: one commit (or none when nothing changed) plus the dossiers index rows. */
export async function runMemoryDigest(b: { db: Db; memory: MemoryW2 }, input: { companyId: string; now: string }): Promise<DigestRun> {
  const wsPaths = (await b.memory.tree("workstreams/")).filter((p) => p.endsWith(".md"));
  const wsFiles: { path: string; title: string; updated: string }[] = [];
  for (const p of wsPaths) {
    const d = await b.memory.read(p);
    if (!d || d.frontmatter.taintedBy) continue;
    wsFiles.push({ path: p, title: (/^# (.+)$/m.exec(d.body)?.[1] ?? p).replace(/[[\]]/g, ""), updated: d.frontmatter.updated });
  }
  const sources = await digestSources(b.db, input.companyId, input.now, wsFiles);
  const out = await b.memory.digest({ now: input.now, sources, companyRef: input.companyId });
  const known = new Map((await b.db.select().from(dossiers)).map((r) => [r.subjectRef, r]));
  for (const d of out.dossiers) {
    const row = known.get(d.subjectRef);
    if (row && row.sourceDigest === d.sourceDigest && row.path === d.path) continue;
    await b.db.insert(dossiers).values({ subjectRef: d.subjectRef, path: d.path, refreshedAt: input.now, sourceDigest: d.sourceDigest })
      .onConflictDoUpdate({ target: dossiers.subjectRef, set: { path: d.path, refreshedAt: input.now, sourceDigest: d.sourceDigest } });
  }
  const summary = out.commit
    ? `Memory digest committed ${out.commit.slice(0, 12)}: ${out.periods.length} periods, ${out.written.length} files written, ${out.removed.length} raw files moved to history.`
    : "Memory digest: nothing changed since the last digest.";
  return { ...out, summary };
}
