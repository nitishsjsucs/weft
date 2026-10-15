"use client";
import { useEffect, useState } from "react";
import { CalendarClock, FastForward, FlaskConical, Mail, MessageSquare, Zap } from "lucide-react";
import { Badge, Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { NoticeScenario, TID, tid, type ArmedFault, type ChatMessageDto, type ToolOutcome } from "@weft/contracts";
import { client, errorText, invalidate, useGet, useMutation, useSimClock } from "@/lib/api/hooks";
import { fmtDateTime, nextCronSlot, relative } from "../format";
import { PageHeader } from "../page";
import { useAgent } from "../agent-context";

const SCENARIOS: Record<(typeof NoticeScenario.options)[number], { label: string; note: string }> = {
  ca_de2088_rate_change: { label: "Deliver CA EDD DE 2088", note: "Revised 2026 UI rate, 3.4% to 1.5%" },
  ca_de2088_injection: { label: "Deliver DE 2088 with an injected line", note: "Same notice plus an instruction aimed at the agent" },
  ny_missing_filing: { label: "Deliver NY missing filing", note: "NYS-45 for Q3 not received" },
  irs_deposit_schedule_change: { label: "Deliver IRS deposit schedule change", note: "Handling is P1" },
};
const FAULT_TARGETS = ["agency.CO.register", "agency.CA.fileResponse", "bank.submitBatch", "idp.createAccount", "devices.order", "chat.post"] as const;
const FAULT_KIND: Record<string, ArmedFault["kind"]> = { "agency.CO.register": "needs_info", "bank.submitBatch": "return", "idp.createAccount": "delay" };
const CHANNELS = ["#people-ops", "#payroll", "#new-hires", "#general"] as const;

/**
 * GET /v1/sim/state has no contract type yet. The API returns simulator rows as snake_case table rows, `idpAccounts`
 * as a count, plus agency mail, device orders, faults and the device catalog. Older mocks sent `idpAccounts` as rows
 * and a `nextEvent`; both forms render.
 */
interface SimState {
  registrations?: Row[]; agencyMail?: Row[]; bankBatches?: Row[]; idpAccounts?: Row[] | number; deviceOrders?: Row[];
  faults?: ArmedFault[]; nextEvent?: { at: string; label: string } | null;
}
type Row = Record<string, unknown>;
const HIDDEN_COLS = new Set(["company_id", "payload_json", "body", "entries_json", "card_json"]);

function cell(col: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "number" && /cents$/.test(col)) return `$${(v / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (typeof v === "string" && /(_at|At)$/.test(col) && !Number.isNaN(Date.parse(v))) return fmtDateTime(v);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function Generic({ rows, empty, testid }: { rows: Row[] | undefined; empty: string; testid: string }) {
  if (!rows?.length) return <div data-testid={testid} className="px-4 py-4 text-[13px] text-gray-10">{empty}</div>;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !HIDDEN_COLS.has(c)).slice(0, 7);
  return (
    <div data-testid={testid} className="overflow-x-auto">
      <Table className="text-[13px]">
        <THead><TR>{cols.map((c) => <TH key={c}>{c.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase()}</TH>)}</TR></THead>
        <TBody>{rows.map((r, i) => <TR key={i}>{cols.map((c) => <TD key={c} className="h-9 font-mono text-1 whitespace-nowrap">{cell(c, r[c])}</TD>)}</TR>)}</TBody>
      </Table>
    </div>
  );
}

function ChatFeed({ channel }: { channel: (typeof CHANNELS)[number] }) {
  const q = useGet("/v1/sim/chat", { query: { channel }, refreshMs: 3_000 });
  const msgs = (q.data ?? []) as ChatMessageDto[];
  return (
    <Card data-testid={tid.chatChannel(channel.slice(1))} className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-3 py-2 text-[13px] font-medium"><MessageSquare className="size-3.5 text-gray-10" />{channel}<span className="ml-auto text-0 font-normal text-gray-10">{msgs.length}</span></div>
      <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto px-3 py-2">
        {msgs.length === 0 ? <li className="text-1 text-gray-10">{q.error ? errorText(q.error) : "No messages."}</li> : null}
        {msgs.slice(-20).map((m) => (
          <li key={m.id} className="text-[13px] leading-5">
            <div className="flex items-baseline gap-2"><span className="font-medium">{m.author}</span><span className="text-0 text-gray-10">{fmtDateTime(m.ts)}</span></div>
            <p className="break-words whitespace-pre-wrap text-gray-12">{m.text}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

async function findNewRun(before: Set<string>, hinted: string | undefined): Promise<string | null> {
  if (hinted) return hinted;
  for (let i = 0; i < 12; i++) {
    try {
      const page = await client.get("/v1/agent/runs", { query: { limit: 10 } });
      const fresh = (page as { data: { id: string }[] }).data.find((r) => !before.has(r.id));
      if (fresh) return fresh.id;
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export function SimulatorsView() {
  const agent = useAgent();
  const clock = useSimClock();
  const state = useGet("/v1/sim/state", { refreshMs: 4_000 });
  const s = (state.data ?? {}) as SimState;
  const [last, setLast] = useState<string | null>(null);
  const advance = useMutation((body: Record<string, string>) => client.post("/v1/sim/clock/advance", { body }));
  const deliver = useMutation(async (scenario: string) => {
    let before = new Set<string>();
    try { before = new Set(((await client.get("/v1/agent/runs", { query: { limit: 10 } })) as { data: { id: string }[] }).data.map((r) => r.id)); } catch { /* list may be unavailable */ }
    const o = (await client.post("/v1/sim/notices/deliver", { body: { scenario } })) as ToolOutcome;
    setLast(o.ok && o.status === "done" ? o.summary : !o.ok ? `${o.refusal.code}: ${o.refusal.message}` : null);
    const hinted = o.ok && o.status === "done" ? (o.data as { agentRunId?: string } | null)?.agentRunId : undefined;
    const runId = await findNewRun(before, hinted);
    if (runId) agent.watch(runId, SCENARIOS[scenario as keyof typeof SCENARIOS]?.label.replace("Deliver ", "Agency notice: ") ?? scenario);
    return o;
  });
  const fault = useMutation((body: Record<string, unknown>) => client.post("/v1/sim/faults", { body }));
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const armed = new Map((s.faults ?? []).filter((f) => f.armed).map((f) => [f.target, f]));
  const serverArmed = (t: string) => armed.has(t as ArmedFault["target"]);
  const isArmed = (t: string) => optimistic[t] ?? serverArmed(t);
  // Drop an optimistic toggle once the server state agrees with it.
  useEffect(() => {
    setOptimistic((o) => Object.fromEntries(Object.entries(o).filter(([t, v]) => serverArmed(t) !== v)));
  }, [state.data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function toggleFault(t: string, on: boolean) {
    setOptimistic((o) => ({ ...o, [t]: on }));
    const r = await fault.run(on ? { target: t, kind: FAULT_KIND[t] ?? "error", mode: "once" } : { target: t, disarm: true });
    if (!r) setOptimistic((o) => { const { [t]: _drop, ...rest } = o; return rest; });
  }
  const now = clock.data?.now;
  const err = clock.error ?? state.error ?? advance.error ?? deliver.error ?? fault.error;
  const step = async (body: Record<string, string>) => { await advance.run(body); invalidate(); };
  const slot = now ? nextCronSlot(now) : null;
  const nextEvent = s.nextEvent ?? (slot ? { at: slot, label: "prebuilt routine slot (weekdays 9:00 AM PT)" } : null);
  const idpRows = Array.isArray(s.idpAccounts) ? s.idpAccounts : undefined;
  const idpCount = typeof s.idpAccounts === "number" ? s.idpAccounts : idpRows?.length;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title={<span className="flex items-center gap-2">Simulators <Badge tone="outline" size="md">Simulated</Badge></span>} subtitle="Demo controls. Agencies, the ACH bank, the identity provider, devices and chat are simulators in this repo; nothing here reaches a real system." />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      <div className="grid grid-cols-1 gap-6 laptop:grid-cols-2 [&>section]:min-w-0">
        <section>
          <CardHeading icon={<CalendarClock />}>Sim clock</CardHeading>
          <Card className="p-4">
            <div className="text-6 font-semibold tabular" data-testid="sim-clock-now">{now ? fmtDateTime(now) : "..."}</div>
            <div className="mt-1 text-1 text-gray-10">Rate {clock.data?.rate ?? "-"}x · cron, expiry and simulator delays all read this clock</div>
            <div className="mt-4 flex min-w-0 flex-wrap gap-2">
              <Button data-testid={tid.simAdvance("30m")} size="sm" disabled={advance.pending} onClick={() => void step({ by: "PT30M" })}><FastForward /> +30 min</Button>
              <Button data-testid={tid.simAdvance("1d")} size="sm" disabled={advance.pending} onClick={() => void step({ by: "P1D" })}><FastForward /> +1 day</Button>
              <Button data-testid={tid.simAdvance("next")} size="sm" disabled={advance.pending} onClick={() => void step({ toNext: "cron" })}><CalendarClock /> Next scheduled event</Button>
            </div>
            {nextEvent ? <p data-testid="sim-next-event" className="mt-3 text-1 break-words text-gray-11">Next: {nextEvent.label} at {fmtDateTime(nextEvent.at)}{now ? ` (${relative(nextEvent.at, now)})` : ""}</p> : null}
          </Card>
        </section>
        <section>
          <CardHeading icon={<Mail />}>Deliver an agency notice</CardHeading>
          <Card className="divide-y divide-[var(--app-border)]">
            {Object.entries(SCENARIOS).map(([k, v]) => (
              <div key={k} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{v.label}</div><div className="truncate text-1 text-gray-10">{v.note} · <code className="font-mono">{k}</code></div></div>
                <Button data-testid={tid.simDeliver(k)} size="sm" disabled={deliver.pending} onClick={() => void deliver.run(k)}>Deliver</Button>
              </div>
            ))}
          </Card>
          {last ? <p className="mt-2 text-1 text-green-11">{last}</p> : null}
        </section>
        <section className="laptop:col-span-2">
          <CardHeading icon={<Zap />}>Fault injection</CardHeading>
          <Card className="grid gap-px overflow-hidden bg-[var(--app-border)] tablet:grid-cols-2 laptop:grid-cols-3">
            {FAULT_TARGETS.map((t) => {
              const on = armed.get(t as ArmedFault["target"]);
              return (
                <label key={t} className="flex cursor-pointer items-center gap-3 bg-card px-4 py-2.5">
                  <input
                    type="checkbox"
                    role="switch"
                    data-testid={tid.simFault(t)}
                    checked={isArmed(t)}
                    onChange={(e) => void toggleFault(t, e.target.checked)}
                    className="size-4 accent-[var(--accent-9)]"
                  />
                  <span className="min-w-0 flex-1"><code className="font-mono text-1">{t}</code><span className="block text-0 text-gray-10">{on ? `armed: ${on.kind}, ${on.mode}, fired ${on.firedCount}` : `off (arms ${FAULT_KIND[t] ?? "error"}, once)`}</span></span>
                  <span className={cn("size-2 rounded-full", isArmed(t) ? "bg-red-9" : "bg-gray-6")} />
                </label>
              );
            })}
          </Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<FlaskConical />}>Agency registrations</CardHeading>
          <Card className="overflow-hidden"><Generic testid="sim-registrations" rows={s.registrations} empty="No registrations." /></Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<FlaskConical />}>Bank batches</CardHeading>
          <Card className="overflow-hidden"><Generic testid="sim-bank-batches" rows={s.bankBatches} empty="No batches." /></Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<FlaskConical />}>Identity provider accounts</CardHeading>
          <Card className="overflow-hidden">
            {idpRows ? <Generic testid="sim-idp-accounts" rows={idpRows} empty="No accounts." /> : (
              <div data-testid="sim-idp-accounts" className="px-4 py-4"><div className="text-6 font-semibold tabular">{idpCount ?? "-"}</div><div className="text-1 text-gray-10">accounts in the simulated identity provider</div></div>
            )}
          </Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<Mail />}>Agency mail</CardHeading>
          <Card className="overflow-hidden"><Generic testid="sim-agency-mail" rows={s.agencyMail} empty="No mail from agencies yet." /></Card>
        </section>
        <section className="min-w-0 laptop:col-span-2">
          <CardHeading icon={<FlaskConical />}>Device orders</CardHeading>
          <Card className="overflow-hidden"><Generic testid="sim-device-orders" rows={s.deviceOrders} empty="No device orders." /></Card>
        </section>
        <section className="min-w-0 laptop:col-span-2">
          <CardHeading icon={<MessageSquare />}>Chat (simulated)</CardHeading>
          <div className="grid grid-cols-1 gap-4 tablet:grid-cols-2">{CHANNELS.map((c) => <ChatFeed key={c} channel={c} />)}</div>
        </section>
      </div>
    </div>
  );
}
