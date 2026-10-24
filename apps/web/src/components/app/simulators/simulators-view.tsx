"use client";
import { useEffect, useState } from "react";
import { CalendarClock, FastForward, FlaskConical, Mail, MessageSquare, Zap } from "lucide-react";
import { Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { ApprovalCardW3, NoticeScenario, TID, tid, type ArmedFault, type ChatMessageDto, type ToolOutcome } from "@weft/contracts";
import { client, errorText, invalidate, useGet, useMutation, useSimClock } from "@/lib/api/hooks";
import { ACCOUNT_TYPE, AGENCY, cents, fmtDateTime, nextCronSlot, relative, statusLabel } from "../format";
import { answerText, humanLine } from "../copy";
import { PageHeader } from "../page";
import { STACK } from "../stack";
import { useAgent } from "../agent-context";
import { ApprovalCard } from "../agent/approval-card";
import { HeldBack } from "../agent/held-back";
import { Untrusted } from "../untrusted-text";
import { SimInboundControls } from "./w4-inbound";   // wave 4 (w4-parity-agent): inbound chat mentions and emailed receipts
import { HOSTED } from "@/lib/hosted/flags";
import { ModelSwitchSection } from "../../hosted/model-switch";

/** A posted approval card with its live status (wave 3): the card JSON was built by the executor from the stored preview. */
function SimChatCard({ card }: { card: ApprovalCardW3 }) {
  const p = useGet("/v1/proposals/:id", { params: { id: card.proposalId }, refreshMs: 3_000 });
  return <><p className="text-gray-12">{cardHeader(p.data?.status ?? card.status)}</p><div className="mt-1.5"><ApprovalCard card={card} status={p.data?.status} taintedBy={p.data?.taintedBy ?? null} known={p.data !== undefined} compact /></div></>;
}

/** The line above a posted card follows the proposal's live status, so a decided card no longer reads "Approval needed". */
export function cardHeader(status: string | undefined): string {
  switch (status) {
    case "executed": case "approved": return "Approved";
    case "denied": return "Denied";
    case "dismissed": return "Dismissed";
    case "expired": return "Expired before a decision";
    case "superseded": case "stale": return "Replaced by a newer proposal";
    case "failed": return "Approved, but it did not run";
    default: return "Waiting for approval";
  }
}

const SCENARIOS: Record<(typeof NoticeScenario.options)[number], { label: string; note: string }> = {
  ca_de2088_rate_change: { label: "Deliver CA EDD DE 2088", note: "Revised 2026 UI rate, 3.4% to 1.5%" },
  ca_de2088_injection: { label: "Deliver DE 2088 with an injected line", note: "Same notice plus an instruction aimed at the agent" },
  ny_missing_filing: { label: "Deliver NY missing filing", note: "NYS-45 for Q3 not received" },
  irs_deposit_schedule_change: { label: "Deliver IRS deposit schedule change", note: "A deposit schedule letter from the IRS" },
};
const FAULT_TARGETS = ["agency.CO.register", "agency.CA.fileResponse", "bank.submitBatch", "idp.createAccount", "devices.order", "chat.post"] as const;
const FAULT_KIND: Record<string, ArmedFault["kind"]> = { "agency.CO.register": "needs_info", "bank.submitBatch": "return", "idp.createAccount": "delay" };
/** What each fault target breaks, in words (the target code is the switch's title). */
const FAULT_LABEL: Record<(typeof FAULT_TARGETS)[number], string> = {
  "agency.CO.register": "CO state registration", "agency.CA.fileResponse": "CA EDD notice reply", "bank.submitBatch": "Bank batch submit",
  "idp.createAccount": "Identity provider account", "devices.order": "Device order", "chat.post": "Chat post",
};
const FAULT_KIND_WORDS: Record<string, string> = { needs_info: "a request for more information", return: "a returned payment", delay: "a delay", error: "an error" };
const CHANNELS = ["#people-ops", "#payroll", "#new-hires", "#general"] as const;

/**
 * GET /v1/sim/state has no contract type yet. The API returns simulator rows as snake_case table rows, `idpAccounts`
 * as a count, plus agency mail, device orders, faults and the device catalog. Older mocks sent `idpAccounts` as rows
 * and a `nextEvent`; both forms render.
 */
interface SimState {
  registrations?: Row[]; agencyMail?: Row[]; bankBatches?: Row[]; idpAccounts?: Row[] | number; deviceOrders?: Row[];
  /** Sections the viewer's grants close (a manager: payroll's bank batches, IT's device orders); they arrive empty. */
  withheld?: ("bankBatches" | "deviceOrders")[];
  faults?: ArmedFault[]; nextEvent?: { at: string; label: string } | null;
}
type Row = Record<string, unknown>;

/** One column of a simulator table: a label people read and how its value reads. */
interface Col { key: string; label: string; fmt?: (v: unknown, r: Row) => string }
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const when = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? fmtDateTime(v) : str(v));
const agencyName = (v: unknown) => AGENCY[str(v) as keyof typeof AGENCY] ?? str(v);
const money = (v: unknown) => (typeof v === "number" ? cents(v) : str(v));
/** A stored code that is a form or a kind ("W2_W3", "rate_change") as words. */
const kindWords = (v: unknown) => { const t = str(v); return /^W2_W3$/i.test(t) ? "W-2 and W-3" : statusLabel(t.toLowerCase()); };
/** "pay_2026_10_15" reads "Oct 15 run". */
const runName = (v: unknown) => humanLine(str(v)).replace(/^the /, "").replace(/^./, (c) => c.toUpperCase());
const SIM_COLS: Record<string, Col[]> = {
  registrations: [
    { key: "agency", label: "Agency", fmt: agencyName },
    { key: "account_type", label: "Account type", fmt: (v) => ACCOUNT_TYPE[str(v) as keyof typeof ACCOUNT_TYPE] ?? statusLabel(str(v)) },
    { key: "status", label: "Status", fmt: (v) => statusLabel(str(v)) },
    { key: "account_number", label: "Account", fmt: (v) => str(v) || "Not issued yet" },
    { key: "complete_at", label: "Completes", fmt: when },
  ],
  bankBatches: [
    { key: "payroll_run_id", label: "Pay run", fmt: runName },
    { key: "total_cents", label: "Amount", fmt: money },
    { key: "entryCount", label: "Payments", fmt: str },
    { key: "status", label: "Status", fmt: (v) => statusLabel(str(v)) },
    { key: "settle_at", label: "Settles", fmt: when },
  ],
  agencyMail: [
    { key: "agency", label: "Agency", fmt: agencyName },
    { key: "direction", label: "Direction", fmt: (v) => (str(v) === "in" || str(v) === "inbound" ? "From the agency" : str(v) === "out" || str(v) === "outbound" ? "To the agency" : statusLabel(str(v))) },
    { key: "kind", label: "Kind", fmt: kindWords },
    { key: "confirmation", label: "Confirmation", fmt: (v) => str(v) || "None" },
    { key: "ts", label: "When", fmt: when },
  ],
  idpAccounts: [
    { key: "system", label: "System", fmt: (v) => humanLine(`Created ${str(v)} account`).replace(/^Created | account$/g, "") },
    { key: "handle", label: "Handle", fmt: str },
    { key: "status", label: "Status", fmt: (v) => statusLabel(str(v)) },
    { key: "created_at", label: "Created", fmt: when },
  ],
  deviceOrders: [
    { key: "sku", label: "Device", fmt: (v) => statusLabel(str(v).replace(/-/g, " ")) },
    { key: "ship_to", label: "Ship to", fmt: str },
    { key: "price_cents", label: "Price", fmt: money },
    { key: "status", label: "Status", fmt: (v) => statusLabel(str(v)) },
    { key: "eta", label: "Arrives", fmt: when },
  ],
};
const MONO = new Set(["account_number", "handle", "confirmation"]);
/** Rows in time order, newest first, by an ISO field (agency mail arrives from several sources out of order). */
export function newestFirst(rows: Row[] | undefined, key: string): Row[] | undefined {
  return rows ? [...rows].sort((a, b) => str(b[key]).localeCompare(str(a[key]))) : rows;
}

/** A simulator table with labeled, formatted columns; the row id and stored JSON sit in the row's title. */
function SimTable({ kind, rows, empty, testid }: { kind: keyof typeof SIM_COLS; rows: Row[] | undefined; empty: string; testid: string }) {
  if (!rows?.length) return <div data-testid={testid} className="px-4 py-4 text-[13px] text-gray-10">{empty}</div>;
  const cols = SIM_COLS[kind]!;
  return (
    // In a column narrower than the table (the docked panel at 1280, a phone) each row stacks (STACK).
    <div data-testid={testid} className={STACK.box}>
      <Table className={cn("text-[13px]", STACK.table)}>
        <THead className={STACK.head}><TR>{cols.map((c) => <TH key={c.key}>{c.label}</TH>)}</TR></THead>
        <TBody>{rows.map((r, i) => (
          <TR key={i} data-row-id={str(r.id)} className={STACK.row}>
            {cols.map((c, j) => <TD key={c.key} data-label={c.label} className={cn("h-9 text-1 whitespace-nowrap", MONO.has(c.key) && "font-mono", j === 0 ? cn(STACK.lead, "@max-[40rem]:font-medium") : cn(STACK.cell, "@max-[40rem]:before:font-sans"))}>{(c.fmt ?? str)(r[c.key], r) || "None"}</TD>)}
          </TR>
        ))}</TBody>
      </Table>
    </div>
  );
}

/**
 * One message. A person's post shows exactly as written, its words (and the name they post under) untrusted for the
 * cursor assistant; Weft's own posts read as copy, and a post that carries an approval card says only that, since the
 * card below names the change.
 */
export function ChatLine({ m }: { m: ChatMessageDto }) {
  const c = ApprovalCardW3.safeParse(m.card);
  return (
    <li className="text-[13px] leading-5">
      <div className="flex items-baseline gap-2"><span className="font-medium">{m.inbound ? <Untrusted>{m.author}</Untrusted> : m.author}</span><span className="text-0 text-gray-10">{fmtDateTime(m.ts)}</span></div>
      {!m.inbound && c.success ? <SimChatCard card={c.data} />
        : m.inbound ? <p data-assist-untrusted="" className="break-words whitespace-pre-wrap text-gray-12">{m.text}</p>
        : <p title={m.text} className="break-words whitespace-pre-wrap text-gray-12">{answerText(m.text).text}</p>}
    </li>
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
        {msgs.slice(-20).map((m) => <ChatLine key={m.id} m={m} />)}
      </ul>
    </Card>
  );
}

/** "in 30m" reads "in 30 min", "in 1h 5m" reads "in 1 h 5 min". */
const relWords = (r: string) => r.replace(/(\d+)m\b/g, "$1 min").replace(/(\d+)h\b/g, "$1 h").replace(/(\d+)d\b/g, "$1 d");

/** Notices the prebuilt agency routine picks up; the others usually start no run, so the wait is short. */
const ROUTED = new Set<string>(["ca_de2088_rate_change", "ca_de2088_injection"]);

async function findNewRun(before: Set<string>, hinted: string | undefined, tries: number): Promise<string | null> {
  if (hinted) return hinted;
  for (let i = 0; i < tries; i++) {
    try {
      const page = await client.get("/v1/agent/runs", { query: { limit: 10 } });
      const fresh = (page as { data: { id: string }[] }).data.find((r) => !before.has(r.id));
      if (fresh) return fresh.id;
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** The delivered notice's held-back lines, and whether the run it started read them (its taint, once it ends). */
function DeliveredHeldBack({ noticeId, runId }: { noticeId: string; runId: string | null }) {
  const n = useGet("/v1/notices/:id", { params: { id: noticeId } });
  const run = useGet("/v1/agent/runs/:id", { params: { id: runId ?? "" }, enabled: !!runId, refreshMs: 2_000 });
  const r = run.data as { status?: string; tainted?: boolean } | undefined;
  const ended = !!r?.status && r.status !== "queued" && r.status !== "running";
  return <div className="mt-2"><HeldBack text={(n.data as { bodyText?: string | null } | undefined)?.bodyText} runRead={r?.tainted ? true : ended ? false : null} /></div>;
}

export function SimulatorsView() {
  const agent = useAgent();
  const clock = useSimClock();
  const state = useGet("/v1/sim/state", { refreshMs: 4_000 });
  const s = (state.data ?? {}) as SimState;
  const [last, setLast] = useState<string | null>(null);
  const [delivered, setDelivered] = useState<{ noticeId: string; runId: string | null } | null>(null);
  const advance = useMutation((body: Record<string, string>) => client.post("/v1/sim/clock/advance", { body }));
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const deliver = useMutation(async (scenario: string) => {
    let before = new Set<string>();
    try { before = new Set(((await client.get("/v1/agent/runs", { query: { limit: 10 } })) as { data: { id: string }[] }).data.map((r) => r.id)); } catch { /* list may be unavailable */ }
    const o = (await client.post("/v1/sim/notices/deliver", { body: { scenario } })) as ToolOutcome;
    setLast(o.ok && o.status === "done" ? `${humanLine(o.summary)}.` : !o.ok ? o.refusal.message : null);
    const hinted = o.ok && o.status === "done" ? (o.data as { agentRunId?: string } | null)?.agentRunId : undefined;
    const noticeId = o.ok && o.status === "done" ? (o.data as { notice_id?: string } | null)?.notice_id ?? null : null;
    setDelivered(noticeId ? { noticeId, runId: null } : null);
    const runId = o.ok ? await findNewRun(before, hinted, ROUTED.has(scenario) ? 12 : 3) : null;
    if (noticeId && runId) setDelivered({ noticeId, runId });
    if (!runId && o.ok && o.status === "done") setLast(`${humanLine(o.summary)}. No routine started a run for this notice, so it waits on the Notices tab of Compliance.`);
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
  const nextEvent = s.nextEvent ? { ...s.nextEvent, label: humanLine(s.nextEvent.label) } : slot ? { at: slot, label: "routine check" } : null;
  const idpRows = Array.isArray(s.idpAccounts) ? s.idpAccounts : undefined;
  const idpCount = typeof s.idpAccounts === "number" ? s.idpAccounts : idpRows?.length;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Simulators" subtitle="Deliver agency notices, move the clock, post to chat and inject faults." />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      {/* Two columns only when each half still holds a five-column table (about 1,100 px of content); else one. */}
      <div className="@container"><div className="grid grid-cols-1 gap-6 @min-[68rem]:grid-cols-2 [&>section]:min-w-0">
        <section>
          <CardHeading icon={<CalendarClock />}>Clock</CardHeading>
          <Card className="p-4">
            <div className="text-6 font-semibold tabular" data-testid="sim-clock-now">{now ? fmtDateTime(now) : "..."}</div>
            <div className="mt-1 text-1 text-gray-10">{clock.data ? (clock.data.rate === 0 ? "Paused" : `Rate ${clock.data.rate}x`) : "Rate -"} · cron, expiry and vendor delays all read this clock</div>
            <div className="mt-4 flex min-w-0 flex-wrap gap-2">
              <Button data-testid={tid.simAdvance("30m")} size="sm" disabled={advance.pending} onClick={() => void step({ by: "PT30M" })}><FastForward /> +30 min</Button>
              <Button data-testid={tid.simAdvance("1d")} size="sm" disabled={advance.pending} onClick={() => void step({ by: "P1D" })}><FastForward /> +1 day</Button>
              <Button data-testid={tid.simAdvance("next")} size="sm" disabled={advance.pending} onClick={() => void step({ toNext: "cron" })}><CalendarClock /> Next scheduled event</Button>
            </div>
            {nextEvent ? <p data-testid="sim-next-event" className="mt-3 text-1 break-words text-gray-11">Next {nextEvent.label}: {fmtDateTime(nextEvent.at)}{now ? ` (${relWords(relative(nextEvent.at, now))})` : ""}</p> : null}
          </Card>
        </section>
        <section>
          <CardHeading icon={<Mail />}>Deliver an agency notice</CardHeading>
          <Card className="divide-y divide-[var(--app-border)]">
            {Object.entries(SCENARIOS).map(([k, v]) => (
              <div key={k} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1" title={k}><div className="text-[13px] font-medium">{v.label}</div><div className="truncate text-1 text-gray-10">{v.note}</div></div>
                <Button data-testid={tid.simDeliver(k)} data-tour="sim-deliver" data-scenario={k} size="sm" disabled={deliver.pending && busyKey === k} onClick={() => { setBusyKey(k); void deliver.run(k); }}>{deliver.pending && busyKey === k ? "Delivering..." : "Deliver"}</Button>
              </div>
            ))}
          </Card>
          {last ? <p className="mt-2 text-1 text-green-11">{last}</p> : null}
          {delivered ? <DeliveredHeldBack noticeId={delivered.noticeId} runId={delivered.runId} /> : null}
        </section>
        {HOSTED ? <ModelSwitchSection /> : null}
        <section className="@min-[68rem]:col-span-2">
          <CardHeading icon={<Zap />}>Fault injection</CardHeading>
          <Card className="grid gap-px overflow-hidden bg-[var(--app-border)] tablet:grid-cols-2 laptop:grid-cols-3">
            {FAULT_TARGETS.map((t) => {
              const on = armed.get(t as ArmedFault["target"]);
              return (
                <label key={t} title={t} className="flex min-w-0 cursor-pointer items-center gap-3 bg-card px-4 py-2.5">
                  <input
                    type="checkbox"
                    role="switch"
                    data-testid={tid.simFault(t)}
                    checked={isArmed(t)}
                    onChange={(e) => void toggleFault(t, e.target.checked)}
                    className="size-4 accent-[var(--accent-9)]"
                  />
                  <span className="min-w-0 flex-1 break-words"><span className="text-1 font-medium">{FAULT_LABEL[t]}</span><span className="block text-0 text-gray-10">{on ? `Armed: ${FAULT_KIND_WORDS[on.kind] ?? statusLabel(on.kind)} ${on.mode === "once" ? "once" : "every time"}, fired ${on.firedCount} ${on.firedCount === 1 ? "time" : "times"}` : `Off. Arming sends ${FAULT_KIND_WORDS[FAULT_KIND[t] ?? "error"]} once`}</span></span>
                  <span className={cn("size-2 shrink-0 rounded-full", isArmed(t) ? "bg-red-9" : "bg-gray-6")} />
                </label>
              );
            })}
          </Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<FlaskConical />}>Agency registrations</CardHeading>
          <Card className="overflow-hidden"><SimTable kind="registrations" testid="sim-registrations" rows={s.registrations} empty="No registrations." /></Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<FlaskConical />}>Bank batches</CardHeading>
          <Card className="overflow-hidden"><SimTable kind="bankBatches" testid="sim-bank-batches" rows={s.bankBatches} empty={s.withheld?.includes("bankBatches") ? "Bank batches carry pay run totals, which are not shared with your role." : "No batches."} /></Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<FlaskConical />}>Identity provider accounts</CardHeading>
          <Card className="overflow-hidden">
            {idpRows ? <SimTable kind="idpAccounts" testid="sim-idp-accounts" rows={idpRows} empty="No accounts." /> : (
              <div data-testid="sim-idp-accounts" className="px-4 py-4"><div className="text-6 font-semibold tabular">{idpCount ?? "-"}</div><div className="text-1 text-gray-10">accounts in the identity provider</div></div>
            )}
          </Card>
        </section>
        <section className="min-w-0">
          <CardHeading icon={<Mail />}>Agency mail</CardHeading>
          <Card className="overflow-hidden"><SimTable kind="agencyMail" testid="sim-agency-mail" rows={newestFirst(s.agencyMail, "ts")} empty="No mail from agencies yet." /></Card>
        </section>
        <section className="min-w-0 @min-[68rem]:col-span-2">
          <CardHeading icon={<FlaskConical />}>Device orders</CardHeading>
          <Card className="overflow-hidden"><SimTable kind="deviceOrders" testid="sim-device-orders" rows={s.deviceOrders} empty={s.withheld?.includes("deviceOrders") ? "Device orders are not shared with your role." : "No device orders."} /></Card>
        </section>
        <SimInboundControls />
        <section className="min-w-0 @min-[68rem]:col-span-2">
          <CardHeading icon={<MessageSquare />}>Chat</CardHeading>
          <div className="grid grid-cols-1 gap-4 tablet:grid-cols-2">{CHANNELS.map((c) => <ChatFeed key={c} channel={c} />)}</div>
        </section>
      </div></div>
    </div>
  );
}
