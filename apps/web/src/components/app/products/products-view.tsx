"use client";
import { longDate } from "../format";
// Benefits, IT and Contractors page bodies (SPEC 11.3 product pages): views over the carrier, identity, device and
// payment rail simulators. Wave 2 (w2-benefits-contractors) adds the Reconciliation and Open enrollment tabs and the
// contractor payouts with rail status; those components live in components/app/benefits and components/app/contractors.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Globe, HeartPulse, Laptop, KeyRound } from "lucide-react";
import { Badge, Card, CardHeading, TBody, TD, TH, THead, TR, Table, Tabs, TabsContent, TabsList, TabsTrigger } from "@weft/ui/components";
import { W2_BENEFITS_TID, type BenefitPlan, type Device, type Enrollment, type ItAccount, type Worker } from "@weft/contracts";
import { ReconciliationTab } from "../benefits/reconciliation-tab";
import { OpenEnrollmentTab } from "../benefits/open-enrollment-tab";
import { PayoutsSection } from "../contractors/payouts-section";
import { client, errorText, useGet, useVersion } from "@/lib/api/hooks";
import { PageHeader } from "../page";
import { fmtDate } from "../format";

type PagedPath = "/v1/benefits/enrollments" | "/v1/it/accounts" | "/v1/it/devices" | "/v1/workers";

/** Reads every page of a cursor-paged list (pages of 100, at most 20 pages). */
function useAll<T extends { id: string }>(path: PagedPath): { rows: T[] | null; error: Error | null } {
  const v = useVersion();
  const [state, setState] = useState<{ rows: T[] | null; error: Error | null }>({ rows: null, error: null });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const out: T[] = [];
        let afterId: string | undefined;
        for (let i = 0; i < 20; i++) {
          const page = (await client.get(path, { query: { limit: 100, ...(afterId ? { afterId } : {}) } })) as { data: T[]; hasMore: boolean };
          out.push(...page.data);
          if (!page.hasMore || !page.data.length) break;
          afterId = page.data[page.data.length - 1]!.id;
        }
        if (live) setState({ rows: out, error: null });
      } catch (e) { if (live) setState((s) => ({ rows: s.rows, error: e as Error })); }
    })();
    return () => { live = false; };
  }, [path, v]);
  return state;
}

const human = (s: string) => s.replace(/_/g, " ");
const dollars = (c: number | undefined) => (c === undefined ? "-" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const PLAN_TYPE: Record<string, string> = { medical: "Medical", dental: "Dental", vision: "Vision", hsa: "HSA", "401k": "401(k)", fsa: "FSA" };
const IT_SYSTEM: Record<string, string> = { google_ws: "Workspace (sim)", chat: "Chat (sim)", github: "Code host (sim)" };

function Empty({ text }: { text: string }) { return <p className="px-4 py-4 text-[13px] text-gray-10">{text}</p>; }

export function BenefitsView() {
  const plans = useGet("/v1/benefits/plans");
  const enr = useAll<Enrollment>("/v1/benefits/enrollments");
  const people = useAll<Worker>("/v1/workers");
  const list = (plans.data ?? []) as BenefitPlan[];
  const active = (enr.rows ?? []).filter((e) => e.status === "active");
  const count = (id: string) => active.filter((e) => e.planId === id).length;
  const names = new Map((people.rows ?? []).map((w) => [w.id, w.displayName]));
  const planNames = new Map(list.map((p) => [p.id, p.name]));
  const err = plans.error ?? enr.error;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title={<span className="flex items-center gap-2">Benefits <Badge tone="outline" size="md">Simulated</Badge></span>} subtitle="Plans and enrollments held by the carrier simulators in this repo. Deductions flow into payroll through the pretax codes." />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      <Tabs defaultValue="plans">
        <TabsList className="mb-2">
          <TabsTrigger value="plans" data-testid={W2_BENEFITS_TID.tabPlans}>Plans</TabsTrigger>
          <TabsTrigger value="reconciliation" data-testid={W2_BENEFITS_TID.tabRecon}>Reconciliation</TabsTrigger>
          <TabsTrigger value="enrollment" data-testid={W2_BENEFITS_TID.tabEnrollment}>Open enrollment</TabsTrigger>
        </TabsList>
        <TabsContent value="plans">
          <CardHeading icon={<HeartPulse />}>Plans</CardHeading>
          <Card className="overflow-hidden">
            {list.length === 0 ? <Empty text={plans.data ? "No plans." : "Loading..."} /> : (
              <Table className="text-[13px]">
                <THead><TR><TH>Plan</TH><TH>Type</TH><TH numeric>Employee only</TH><TH numeric>Employer</TH><TH numeric>Enrolled</TH></TR></THead>
                <TBody>
                  {list.map((p) => (
                    <TR key={p.id} data-testid={`benefit-plan-${p.id}`}>
                      <TD className="h-12 py-1.5"><div className="font-medium">{p.name}</div><div className="text-1 text-gray-10">{p.carrier} · <code className="font-mono text-0">{p.pretaxCode}</code></div></TD>
                      <TD className="h-12">{PLAN_TYPE[p.type] ?? human(p.type)}</TD>
                      <TD numeric className="h-12">{p.prices.ee !== undefined ? dollars(p.prices.ee) : p.match ? <span className="text-gray-11">Employer match</span> : "-"}</TD>
                      <TD numeric className="h-12">{dollars(p.prices.employer)}</TD>
                      <TD numeric className="h-12">{enr.rows ? count(p.id) : "..."}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
          <p className="mt-3 text-1 text-gray-10">{enr.rows ? `${active.length} active enrollments across ${new Set(active.map((e) => e.workerId)).size} people.` : ""} Per-person enrollments are on each person&apos;s Benefits tab.</p>
        </TabsContent>
        <TabsContent value="reconciliation"><ReconciliationTab names={names} plans={planNames} /></TabsContent>
        <TabsContent value="enrollment"><OpenEnrollmentTab /></TabsContent>
      </Tabs>
    </div>
  );
}

export function ItView() {
  const acc = useAll<ItAccount>("/v1/it/accounts");
  const dev = useAll<Device>("/v1/it/devices");
  const people = useAll<Worker>("/v1/workers");
  const name = new Map((people.rows ?? []).map((w) => [w.id, w.displayName]));
  const bySystem = new Map<string, ItAccount[]>();
  for (const a of acc.rows ?? []) bySystem.set(a.system, [...(bySystem.get(a.system) ?? []), a]);
  const err = acc.error ?? dev.error;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title={<span className="flex items-center gap-2">IT <Badge tone="outline" size="md">Simulated</Badge></span>} subtitle="Accounts and laptops held by the identity provider and device simulators in this repo." />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      <div className="flex flex-col gap-6 [&>section]:min-w-0">
        <section>
          <CardHeading icon={<KeyRound />}>Accounts by system</CardHeading>
          <Card className="grid divide-y divide-[var(--app-border)] tablet:grid-cols-3 tablet:divide-x tablet:divide-y-0">
            {!acc.rows ? <Empty text="Loading..." /> : bySystem.size === 0 ? <Empty text="No accounts." /> : [...bySystem.entries()].map(([sys, rows]) => (
              <div key={sys} data-testid={`it-system-${sys}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <span className="min-w-0 flex-1 font-medium">{IT_SYSTEM[sys] ?? sys}</span>
                <span className="tabular text-gray-11">{rows.filter((r) => r.status === "active").length} active</span>
                {rows.some((r) => r.status !== "active") ? <Badge tone="amber">{rows.filter((r) => r.status !== "active").length} other</Badge> : null}
              </div>
            ))}
          </Card>
        </section>
        <section>
          <CardHeading icon={<Laptop />}>Devices</CardHeading>
          <Card className="overflow-hidden">
            {!dev.rows ? <Empty text="Loading..." /> : dev.rows.length === 0 ? <Empty text="No devices." /> : (
              <div className="max-h-[420px] overflow-y-auto">
                <Table className="text-[13px]">
                  <THead><TR><TH>Person</TH><TH>Model</TH><TH>Status</TH><TH numeric>Price</TH></TR></THead>
                  <TBody>
                    {dev.rows.map((d) => (
                      <TR key={d.id} data-testid={`device-${d.id}`}>
                        <TD className="h-9 whitespace-nowrap"><Link href={`/app/people/${d.workerId}`} className="hover:underline">{name.get(d.workerId) ?? d.workerId}</Link></TD>
                        <TD className="h-9 text-gray-11">{d.model}</TD>
                        <TD className="h-9 whitespace-nowrap"><Badge tone={d.status === "assigned" ? "green" : "gray"}>{human(d.status)}</Badge></TD>
                        <TD numeric className="h-9 whitespace-nowrap">{d.price.display}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}

export function ContractorsView() {
  const q = useGet("/v1/workers", { query: { type: "contractor", limit: 100 } });
  const rows = (q.data?.data ?? []) as Worker[];
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title={<span className="flex items-center gap-2">Contractors <Badge tone="outline" size="md">Simulated</Badge></span>} subtitle="Global contractors on the monthly schedule, paid through the fixed FX table and the payment rail simulator." />
      {q.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(q.error)}</div> : null}
      <CardHeading icon={<Globe />}>Contractors</CardHeading>
      <Card className="overflow-hidden">
        {rows.length === 0 ? <Empty text={q.data ? "No contractors." : "Loading..."} /> : (
          <Table className="text-[13px]">
            <THead><TR><TH>Name</TH><TH>Role</TH><TH>Country</TH><TH>Currency</TH><TH>Since</TH><TH>Status</TH></TR></THead>
            <TBody>
              {rows.map((w) => (
                <TR key={w.id} data-testid={`contractor-${w.id}`}>
                  <TD className="h-10 whitespace-nowrap"><Link href={`/app/people/${w.id}`} className="font-medium hover:underline">{w.displayName}</Link></TD>
                  <TD className="h-10">{w.title}</TD>
                  <TD className="h-10">{w.country}</TD>
                  <TD className="h-10 font-mono text-1">{w.currency}</TD>
                  <TD className="h-10 whitespace-nowrap">{w.startDate ? longDate(w.startDate) : "Not set"}</TD>
                  <TD className="h-10 capitalize">{w.status}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <PayoutsSection contractors={rows} />
    </div>
  );
}
