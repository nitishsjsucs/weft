"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { CircleCheck, CircleDashed, CircleSlash } from "lucide-react";
import { Badge, Button, Card, Tabs, TabsContent, TabsList, TabsTrigger, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { tid, type BenefitPlan, type Enrollment, type ItAccount, type Money, type Offer, type ToolOutcome, type Worker } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDate, initials } from "../format";
import { PageHeader } from "../page";
import { DocumentLibrary } from "../documents/document-library";
import { PersonActions } from "../offboarding/person-actions";

const DEPT: Record<string, string> = { dpt_engineering: "Engineering", dpt_hardware: "Hardware", dpt_operations: "Operations", dpt_people: "People", dpt_finance: "Finance", dpt_gtm: "Go-to-market" };
const deptName = (id: string | null) => (id ? (DEPT[id] ?? id) : "-");
export const STATUS_CLASS: Record<Worker["status"], string> = { active: "text-green-11", onboarding: "text-blue-11", offboarding: "text-amber-11", invited: "text-blue-11", draft: "text-gray-10", inactive: "text-gray-10" };

const features = tableFeatures({});
const h = createColumnHelper<typeof features, Worker>();
const columns = h.columns([
  h.accessor("displayName", { header: "Name" }),
  h.accessor("title", { header: "Title" }),
  h.display({ id: "department", header: "Department", cell: (c) => deptName(c.row.original.departmentId) }),
  h.display({ id: "state", header: "State", cell: (c) => c.row.original.workState ?? c.row.original.country }),
  h.accessor("status", { header: "Status" }),
]);

function PeopleTable({ data }: { data: Worker[] }) {
  const table = useTable({ features, columns, data });
  return (
    <Card className="overflow-hidden">
      <Table className="min-w-[720px]">
        <THead>{table.getHeaderGroups().map((g) => <TR key={g.id}>{g.headers.map((hd) => <TH key={hd.id}>{hd.isPlaceholder ? null : <table.FlexRender header={hd} />}</TH>)}</TR>)}</THead>
        <TBody>
          {table.getRowModel().rows.map((r) => {
            const w = r.original;
            return (
              <TR key={r.id} data-testid={`people-row-${w.id}`} className="hover:bg-gray-2">
                {r.getAllCells().map((cell) =>
                  cell.column.id === "displayName" ? (
                    <TD key={cell.id}>
                      <Link href={`/app/people/${w.id}`} className="flex items-center gap-2.5">
                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-gray-4 text-0 font-medium text-gray-11">{initials(w.displayName)}</span>
                        <span className="min-w-0"><span className="block truncate font-medium">{w.displayName}</span><span className="block truncate text-1 text-gray-10">{w.workEmail}</span></span>
                      </Link>
                    </TD>
                  ) : cell.column.id === "status" ? (
                    <TD key={cell.id} className={`font-medium capitalize ${STATUS_CLASS[w.status]}`}>{w.status}</TD>
                  ) : (
                    <TD key={cell.id} className="text-gray-11"><table.FlexRender cell={cell} /></TD>
                  ),
                )}
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}

function OfferCard({ o }: { o: Offer }) {
  const [out, setOut] = useState<ToolOutcome | null>(null);
  const accept = useMutation(() => client.post("/v1/offers/:id/accept", { params: { id: o.id } }));
  return (
    <Card className="flex flex-col gap-3 p-4 tablet:flex-row tablet:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-3 font-medium">{o.candidateFirst} {o.candidateLast} (demo)</div>
        <div className="text-[13px] text-gray-11">{o.title} · {deptName(o.departmentId)} · work state {o.workState} · {o.base.display} a year · starts {fmtDate(o.startDate, { month: "short", day: "numeric", year: "numeric" })}</div>
        {out && !out.ok ? <div role="alert" className="mt-1 text-1 text-red-11">{out.refusal.code}: {out.refusal.message}</div> : null}
        {accept.error ? <div role="alert" className="mt-1 text-1 text-red-11">{errorText(accept.error)}</div> : null}
        {o.workerId ? <Link href={`/app/people/${o.workerId}`} className="mt-1 inline-block text-1 text-blue-11 hover:underline">Open onboarding</Link> : null}
      </div>
      <Badge tone={o.status === "accepted" ? "green" : o.status === "sent" ? "blue" : "gray"} size="md" data-status={o.status}>{o.status.charAt(0).toUpperCase() + o.status.slice(1)}</Badge>
      {o.status === "sent" ? (
        <Button data-testid={tid.offerAccept(o.id)} variant="primary" size="sm" disabled={accept.pending} onClick={async () => setOut((await accept.run()) ?? null)} title="Demo action: records the candidate's acceptance">Mark accepted</Button>
      ) : null}
    </Card>
  );
}

export function PeopleView() {
  const workers = useGet("/v1/workers", { query: { limit: 100 }, refreshMs: 5_000 });
  const offers = useGet("/v1/offers", { query: { limit: 100 }, refreshMs: 5_000 });
  const [q, setQ] = useState("");
  const data = useMemo(() => (workers.data?.data ?? []).filter((w) => !q || `${w.displayName} ${w.title} ${w.workState}`.toLowerCase().includes(q.toLowerCase())), [workers.data, q]);
  const err = workers.error ?? offers.error;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="People" subtitle="Everyone at Larkspur Robotics (demo). All people are synthetic." />
      {err ? <div role="alert" className="mb-4 text-1 text-red-11">{errorText(err)}</div> : null}
      <Tabs defaultValue="people">
        <TabsList>
          <TabsTrigger value="people">People {workers.data ? <Badge size="xs">{workers.data.count}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="offers">Offers {offers.data ? <Badge size="xs">{offers.data.data.filter((o) => o.status === "sent").length}</Badge> : null}</TabsTrigger>
        </TabsList>
        <TabsContent value="people">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, title or state" aria-label="Filter people" className="mb-3 h-8 w-full max-w-[320px] rounded-lg border border-[var(--app-border)] bg-card px-3 text-[13px]" />
          <PeopleTable data={data} />
        </TabsContent>
        <TabsContent value="offers">
          <div className="flex flex-col gap-3">
            {(offers.data?.data ?? []).map((o) => <OfferCard key={o.id} o={o} />)}
            {offers.data && offers.data.data.length === 0 ? <div className="text-2 text-gray-10">No offers.</div> : null}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const TASK_LABEL: Record<string, string> = { sign_offer: "Sign offer", sign_confidentiality: "Sign confidentiality agreement", federal_w4: "Federal W-4", state_withholding: "State withholding", direct_deposit: "Direct deposit", i9_sim: "I-9 (simulated)", benefits_selection: "Benefits selection", it_accounts: "IT accounts", device: "Laptop", state_registration: "State tax registration" };

/** GET /v1/workers/:id returns a WorkerDetail (route table); the scaffold client types it as Worker, so both are read. */
interface PayRate { id: string; kind: string; amount: Money; effectiveFrom: string; effectiveTo: string | null; createdActionSeq: number | null }
interface Detail {
  worker: Worker; department: string | null; manager: string | null; workplace: string | null; payRates: PayRate[];
  bankAccount: { bankName: string; last4: string; status: string; source: string } | null;
  taxProfile: { w4Version: string; filingStatus: string; stateFilingStatus: string | null; stateAllowances: number | null; source: string } | null;
}
export function toDetail(v: unknown): Detail | null {
  if (!v || typeof v !== "object") return null;
  if ("worker" in v) return v as Detail;
  return { worker: v as Worker, department: null, manager: null, workplace: null, payRates: [], bankAccount: null, taxProfile: null };
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.flatMap(([k, v]) => [<dt key={`k${k}`} className="text-gray-10">{k}</dt>, <dd key={`v${k}`} className="min-w-0 break-words">{v}</dd>])}
    </dl>
  );
}

function PayTab({ d }: { d: Detail }) {
  return (
    <div className="flex flex-col gap-6 [&>*]:min-w-0">
      <Card className="overflow-hidden">
        <h2 className="px-4 pt-4 pb-2 text-1 font-medium text-gray-10 uppercase">Pay rate history</h2>
        {d.payRates.length === 0 ? <p className="px-4 pb-4 text-[13px] text-gray-10">No pay rates on file.</p> : (
          <Table className="text-[13px]">
            <THead><TR><TH>Kind</TH><TH numeric>Amount</TH><TH>Effective</TH><TH>Source</TH></TR></THead>
            <TBody>
              {[...d.payRates].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)).map((r) => (
                <TR key={r.id} data-testid={`pay-rate-${r.id}`}>
                  <TD className="h-10 capitalize">{r.kind}</TD>
                  <TD numeric className="h-10">{r.amount.display}{r.kind === "salary" ? " a year" : r.kind === "hourly" ? " an hour" : ""}</TD>
                  <TD className="h-10 whitespace-nowrap">{fmtDate(r.effectiveFrom, { month: "short", day: "numeric", year: "numeric" })}{r.effectiveTo ? ` to ${fmtDate(r.effectiveTo, { month: "short", day: "numeric", year: "numeric" })}` : " onward"}</TD>
                  <TD className="h-10">{r.createdActionSeq ? <Link className="text-blue-11 hover:underline" href={`/app/audit#audit-${r.createdActionSeq}`}>action #{r.createdActionSeq}</Link> : <span className="text-gray-10">seed</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <div className="grid gap-6 tablet:grid-cols-2 [&>*]:min-w-0">
        <Card className="p-4">
          <h2 className="mb-3 text-1 font-medium text-gray-10 uppercase">Direct deposit</h2>
          {d.bankAccount ? <Facts rows={[["Bank", d.bankAccount.bankName], ["Account", `ending ${d.bankAccount.last4}`], ["Status", d.bankAccount.status]]} /> : <p className="text-[13px] text-amber-11">No bank account. Paychecks are blocked until direct deposit is set up.</p>}
        </Card>
        <Card className="p-4">
          <h2 className="mb-3 text-1 font-medium text-gray-10 uppercase">Tax setup</h2>
          {d.taxProfile ? <Facts rows={[["W-4", d.taxProfile.w4Version], ["Federal filing", human(d.taxProfile.filingStatus)], ["State filing", d.taxProfile.stateFilingStatus ? human(d.taxProfile.stateFilingStatus) : "-"], ["State allowances", d.taxProfile.stateAllowances === null ? "-" : String(d.taxProfile.stateAllowances)], ["Work state", d.worker.workState ?? "-"]]} /> : <p className="text-[13px] text-gray-10">No tax profile yet.</p>}
        </Card>
      </div>
    </div>
  );
}

function BenefitsTab({ id }: { id: string }) {
  const enr = useGet("/v1/benefits/enrollments", { query: { workerId: id, limit: 50 } });
  const plans = useGet("/v1/benefits/plans");
  const byId = new Map(((plans.data ?? []) as BenefitPlan[]).map((p) => [p.id, p]));
  const rows = ((enr.data as { data?: Enrollment[] } | undefined)?.data ?? []);
  return (
    <Card className="overflow-hidden">
      {rows.length === 0 ? <p className="p-4 text-[13px] text-gray-10">{enr.error ? errorText(enr.error) : enr.data ? "No enrollments." : "Loading..."}</p> : (
        <Table className="text-[13px]">
          <THead><TR><TH>Plan</TH><TH>Carrier</TH><TH>Tier</TH><TH numeric>Per paycheck</TH><TH>Effective</TH><TH>Status</TH></TR></THead>
          <TBody>
            {rows.map((e) => {
              const p = byId.get(e.planId);
              return (
                <TR key={e.id} data-testid={`enrollment-${e.id}`}>
                  <TD className="h-10">{p?.name ?? e.planId}<span className="ml-1.5 text-1 text-gray-10">{p ? human(p.type) : ""}</span></TD>
                  <TD className="h-10">{p?.carrier ?? "-"}</TD>
                  <TD className="h-10">{e.tier ? human(e.tier) : "-"}</TD>
                  <TD numeric className="h-10">{e.employeeCents !== null ? `$${(e.employeeCents / 100).toFixed(2)}` : e.deferralBps !== null ? `${(e.deferralBps / 100).toFixed(1)}% deferral` : "-"}</TD>
                  <TD className="h-10 whitespace-nowrap">{fmtDate(e.effectiveFrom, { month: "short", day: "numeric", year: "numeric" })}</TD>
                  <TD className="h-10"><Badge tone={e.status === "active" ? "green" : "gray"}>{human(e.status)}</Badge></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function ItTab({ id }: { id: string }) {
  const acc = useGet("/v1/it/accounts", { query: { workerId: id, limit: 50 }, refreshMs: 5_000 });
  const rows = ((acc.data as { data?: ItAccount[] } | undefined)?.data ?? []);
  return (
    <Card className="overflow-hidden">
      {rows.length === 0 ? <p className="p-4 text-[13px] text-gray-10">{acc.error ? errorText(acc.error) : acc.data ? "No accounts yet." : "Loading..."}</p> : (
        <Table className="text-[13px]">
          <THead><TR><TH>System (simulated)</TH><TH>Handle</TH><TH>Groups</TH><TH>Status</TH></TR></THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.id} data-testid={`it-account-${a.id}`}>
                <TD className="h-10">{IT_SYSTEM[a.system] ?? a.system}</TD>
                <TD className="h-10 font-mono text-1">{a.handle}</TD>
                <TD className="h-10 text-gray-11">{a.groups.join(", ") || "-"}</TD>
                <TD className="h-10"><Badge tone={a.status === "active" ? "green" : "gray"}>{human(a.status)}</Badge></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

const IT_SYSTEM: Record<string, string> = { google_ws: "Workspace (sim)", chat: "Chat (sim)", github: "Code host (sim)" };
const human = (s: string) => s.replace(/_/g, " ");

export function PersonView({ id }: { id: string }) {
  const w = useGet("/v1/workers/:id", { params: { id }, refreshMs: 5_000 });
  const tasks = useGet("/v1/workers/:id/onboarding", { params: { id }, refreshMs: 3_000 });
  const d = toDetail(w.data);
  const p = d?.worker;
  const [tab, setTab] = useState("profile");
  const list = (tasks.data ?? []) as { id: string; kind: string; status: "pending" | "done" | "blocked"; owner: string; dueOn: string | null; blockedReason: string | null }[];
  if (w.error && !p) return <div role="alert" className="p-8 text-2 text-red-11">{errorText(w.error)}</div>;
  if (!d || !p) return <div className="p-8 text-2 text-gray-10">Loading...</div>;
  const onboarding = (
    <Card className="p-4">
      <h2 className="mb-3 text-1 font-medium text-gray-10 uppercase">Onboarding checklist</h2>
      {list.length === 0 ? <p className="text-[13px] text-gray-10">{tasks.error ? errorText(tasks.error) : "No onboarding tasks."}</p> : (
        <ul className="flex flex-col gap-2">
          {list.map((t) => (
            <li key={t.id} data-testid={tid.onboardingTask(t.kind)} data-status={t.status} className="flex items-start gap-2 text-[13px]">
              {t.status === "done" ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-11" /> : t.status === "blocked" ? <CircleSlash className="mt-0.5 size-4 shrink-0 text-amber-11" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-gray-9" />}
              <div className="min-w-0 flex-1">
                <div>{TASK_LABEL[t.kind] ?? t.kind} <span className="text-gray-10">· {t.status === "done" ? "Done" : t.status === "blocked" ? "Blocked" : "Pending"} · {t.owner}</span></div>
                {t.blockedReason ? <div className="text-1 text-amber-11">{t.blockedReason}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title={p.displayName} subtitle={`${p.title} · ${d.department ?? deptName(p.departmentId)}${d.workplace ? ` · ${d.workplace}` : ""}`} meta={<span className="flex items-center gap-3"><span className={`text-2 font-medium capitalize ${STATUS_CLASS[p.status]}`}>{p.status}</span><PersonActions workerId={p.id} status={p.status} /></span>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 overflow-x-auto">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="pay">Pay and tax</TabsTrigger>
          <TabsTrigger value="benefits">Benefits</TabsTrigger>
          <TabsTrigger value="it">IT accounts</TabsTrigger>
          <TabsTrigger value="onboarding">Onboarding {list.length ? <Badge size="xs">{list.filter((t) => t.status !== "done").length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <div className="grid gap-6 laptop:grid-cols-[1fr_1fr] [&>*]:min-w-0">
            <Card className="p-4">
              <h2 className="mb-3 text-1 font-medium text-gray-10 uppercase">Profile</h2>
              <Facts rows={[["Employee number", p.employeeNumber ?? "-"], ["Work email", p.workEmail], ["Manager", d.manager ?? "-"], ["Work state", p.workState ?? "-"], ["Country", p.country], ["Type", p.workerType], ["Start date", p.startDate], ["End date", p.endDate ?? "-"], ["SSN", p.ssnMasked ?? "Not on file"], ["Pay schedule", p.payScheduleId ?? "-"], ["Time zone", p.timezone]]} />
            </Card>
            {onboarding}
          </div>
        </TabsContent>
        <TabsContent value="pay"><PayTab d={d} /></TabsContent>
        <TabsContent value="benefits">{tab === "benefits" ? <BenefitsTab id={id} /> : null}</TabsContent>
        <TabsContent value="it">{tab === "it" ? <ItTab id={id} /> : null}</TabsContent>
        <TabsContent value="onboarding">{onboarding}</TabsContent>
        <TabsContent value="documents">{tab === "documents" ? <DocumentLibrary workerId={id} /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
