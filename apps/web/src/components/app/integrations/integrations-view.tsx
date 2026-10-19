"use client";
// Integrations (docs/wave3.md 3.1, research/wave3/integrations-hr.md 3.7). Owner: w3-integrations-hr.
// Five cards from GET /v1/integrations: the mode (Simulated or Connected), health, the secret names the real adapter
// needs with present or missing (never a value), the free path, a connection test and, for Greenhouse, the simulator
// and Workday simulator demo controls. Below: the sync items people decide (keep the Weft value or take the vendor
// value), the hires imported as draft offers, the time off imported from Workday and the open roles. Vendor names say what Weft connects to; no logos.
import { Fragment, useState } from "react";
import { Badge, Button, Card } from "@weft/ui/components";
import { W3_INTEGRATIONS_HR_TID as H, W3_INTEGRATIONS_TID as T, type ConnectorStatus, type IntegrationCard, type SyncItem } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { cents, fmtDate, fmtDateTime } from "../format";
import { PageHeader } from "../page";

const CATEGORY_LABEL: Record<string, string> = { ats: "Applicant tracking", hris: "HR system of record", screening: "Background screening", esign: "E-signature" };
const HEALTH_LABEL: Record<string, string> = { ok: "Healthy", auth_failed: "Sign-in failed", rate_limited: "Rate limited", permission_gap: "Permission gap", unreachable: "Unreachable", not_available: "Not available" };
const KIND_LABEL: Record<string, string> = { sync_conflict: "Conflict", unmapped_value: "Unmapped value", orphaned: "Orphaned", permission_gap: "Permission gap" };
const SIMULATE: Record<string, { kind: string; label: string }[]> = {
  greenhouse: [{ kind: "hire", label: "Simulate a hire" }, { kind: "start_date_change", label: "Change the start date" }, { kind: "redeliver", label: "Resend the last delivery" }],
  workday: [{ kind: "worker_change", label: "Promote someone in Workday" }, { kind: "time_off", label: "Approve two days off" }],
};
const VENDOR_LABEL: Record<string, string> = { greenhouse: "Greenhouse", workday: "Workday", checkr: "Checkr", hireright: "HireRight", docusign: "DocuSign" };
const FIELD_LABEL: Record<string, string> = { start_date: "Start date", base_cents: "Base pay (cents)", title: "Title", work_state: "Work state", termination_date: "Termination date", office: "Office", department: "Department", worker: "Worker", time_off_type: "Time-off type" };
const OWNER_LABEL: Record<string, string> = { people: "People", compensation: "Compensation", time_off: "Time off" };
/** Where credentials alone do not make a card real, the card says so next to its free path. */
const VENDOR_COPY_NOTE: Record<string, string> = {
  workday: "Real adapter not built yet: the simulator runs even when every Workday secret is present.",
  hireright: "Simulated, API shape not published: the simulator uses Weft's own screening shape.",
};

interface Imported { applicationRef: string; offerVersion: number | null; offerId: string; status: string | null; candidate: string | null; title: string | null; startDate: string | null; workState: string | null }
interface WorkdayTimeOff { requestId: string; workerId: string; worker: string; date: string; minutes: number; status: string; entryRef: string }
interface Job { id: string; name: string; departmentName: string | null; officeName: string | null; location: string | null; url: string | null }

/** What the mode badge says: Connected, Real but switched off by the live flags, or Simulated. */
function modeLabel(card: IntegrationCard): { text: string; tone: "green" | "amber" | "gray" } {
  if (card.status.mode !== "real") return { text: "Simulated", tone: "gray" };
  return card.status.health === "permission_gap" ? { text: "Real, disabled", tone: "amber" } : { text: "Connected", tone: "green" };
}

function VendorCard({ card }: { card: IntegrationCard }) {
  const v = card.status.vendor;
  const [note, setNote] = useState<string | null>(null);
  const test = useMutation(async () => (await client.post("/v1/integrations/:vendor/test", { params: { vendor: v } })) as ConnectorStatus & { tested?: boolean });
  const sim = useMutation(async (kind: string) => (await client.post("/v1/integrations/:vendor/simulate", { params: { vendor: v }, body: { kind } })) as { summary?: string; data?: { weft_offer_id?: string | null } });
  const sync = useMutation(async () => (await client.post("/v1/integrations/:vendor/sync", { params: { vendor: v } })) as { summary?: string; data?: { applied?: { summary?: string } | null } });
  const connected = card.status.mode === "real";
  const mode = modeLabel(card);
  const required = card.secrets.filter((s) => !s.optional), optional = card.secrets.filter((s) => s.optional);
  const err = test.error ?? sim.error ?? sync.error;
  const simulate = connected ? [] : SIMULATE[v] ?? [];
  const realNote = VENDOR_COPY_NOTE[v];
  return (
    <Card data-testid={T.card(v)} data-tour="integration-card" data-mode={card.status.mode} className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-[7.5rem] shrink-0">
          <h2 className="text-3 font-medium">{card.title}</h2>
          <p className="text-1 text-gray-10">{CATEGORY_LABEL[card.status.category] ?? card.status.category}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge data-testid={T.mode(v)} tone={mode.tone} size="md">{mode.text}</Badge>
          <Badge data-testid={H.health(v)} tone={card.status.health === "ok" ? "outline" : "amber"} size="md">{HEALTH_LABEL[card.status.health] ?? card.status.health}</Badge>
        </div>
      </div>
      <p className="text-2 text-gray-12">{card.body}</p>
      {card.ownership ? (
        <p data-testid={H.ownership(v)} data-owner={Object.values(card.ownership).includes("vendor") ? "vendor" : "weft"} className="text-1 text-gray-11">
          {(["vendor", "weft"] as const).map((who) => {
            const keys = Object.entries(card.ownership!).filter(([, o]) => o === who).map(([k]) => OWNER_LABEL[k] ?? k);
            return keys.length ? <span key={who} className="block">{who === "vendor" ? `${card.title} owns` : "Weft owns"}: {keys.join(", ")}.</span> : null;
          })}
          {Object.values(card.ownership).includes("vendor") ? <span className="block text-gray-10">Owned fields are read-only in Weft; time off from {card.title} lands as approved requests.</span> : <span className="block text-gray-10">The first Sync now links people by work email and hands these to {card.title}.</span>}
        </p>
      ) : null}
      <div className="rounded-lg bg-gray-2 p-3 text-1 text-gray-11">
        <div className="mb-1 font-medium text-gray-12">Free path</div>
        {card.freePath}
        {realNote ? <p data-testid={`integration-${v}-real-note`} className="mt-1.5 text-gray-12">{realNote}</p> : null}
      </div>
      <div>
        <div className="mb-1 text-1 font-medium text-gray-10 uppercase">Secrets file</div>
        {required.length === 0 ? <p className="text-1 text-gray-10">No credentials can make this one real yet.</p> : (
          <ul className="flex flex-col gap-1">
            {[...required, ...optional].map((s) => (
              <li key={s.name} data-testid={H.secret(v, s.name)} data-present={s.present ? "yes" : "no"} className="flex items-start justify-between gap-2 text-1">
                <span className="min-w-0"><code className="font-mono text-[12px] text-gray-12">{s.name.split("_").map((part, i, all) => <Fragment key={i}>{part}{i < all.length - 1 ? <>_<wbr /></> : null}</Fragment>)}</code>{s.optional ? <span className="ml-1 whitespace-nowrap text-gray-10">(optional)</span> : null}</span>
                <span className={`shrink-0 ${s.present ? "text-green-11" : "text-gray-10"}`}>{s.present ? "Present" : "Missing"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" data-testid={T.test(v)} disabled={test.pending}
            onClick={() => void test.run().then((s) => s && setNote(`${s.tested === false ? "Status (not tested)" : "Test"}: ${HEALTH_LABEL[s.health] ?? s.health}${s.detail ? ` (${s.detail.replace(/_/g, " ")})` : ""}`))}>Test connection</Button>
          {v === "greenhouse" || v === "workday" ? <Button size="sm" variant="secondary" data-testid={H.sync(v)} disabled={sync.pending} onClick={() => void sync.run().then((r) => r && setNote(r.summary ?? "Synced"))}>Sync now</Button> : null}
        </div>
        {simulate.length ? (
          <div className="border-t border-[var(--app-border)] pt-3">
            <div className="mb-2 text-1 font-medium text-gray-10">Simulator</div>
            <div className="flex flex-wrap items-center gap-2">
              {simulate.map((s) => (
                <Button key={s.kind} size="sm" variant="secondary" data-testid={T.simulate(v, s.kind)} disabled={sim.pending}
                  onClick={() => void sim.run(s.kind).then((r) => r && setNote(r.summary ?? "Done"))}>{s.label}</Button>
              ))}
            </div>
          </div>
        ) : null}
        {note ? <p data-testid={H.testResult(v)} className="text-1 text-gray-11">{note}{card.status.lastSyncAt ? ` · last sync ${fmtDateTime(card.status.lastSyncAt)}` : ""}</p> : null}
        {err ? <p role="alert" className="text-1 text-red-11">{errorText(err)}</p> : null}
      </div>
    </Card>
  );
}

/** A synced value as a person reads it: a date as a day, cents as dollars, anything else as stored. */
export function syncValue(field: string | undefined, v: string | undefined): string {
  if (!v) return "nothing";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
  if ((field === "base_cents" || field === "salary") && /^\d+$/.test(v)) return cents(Number(v));
  return v;
}

/** What a sync item is about: the candidate's offer by name, a Greenhouse application by its number. */
export function syncSubject(subjectRef: string, offers: Record<string, string>): string {
  if (offers[subjectRef]) return `${offers[subjectRef]}'s offer`;
  const app = /^greenhouse:application:(\w+)$/.exec(subjectRef);
  if (app) return `Greenhouse application ${app[1]}`;
  return /^offr_/.test(subjectRef) ? "An offer" : subjectRef;
}

function SyncItemRow({ s, simulated, offers }: { s: SyncItem; simulated: boolean; offers: Record<string, string> }) {
  const resolve = useMutation(async (take: "weft" | "vendor") => client.post("/v1/sync-items/:id/resolve", { params: { id: s.id }, body: { take } }));
  const d = s.detail;
  const vendor = VENDOR_LABEL[s.vendor] ?? s.vendor;
  // Pay values read as dollars (syncValue), so the stored "(cents)" unit leaves the label.
  const field = (d.label ?? FIELD_LABEL[d.field ?? ""] ?? d.field ?? "").replace(/ \(cents\)$/, "");
  const payChange = d.reason === "pay_affecting";
  const text = s.kind === "sync_conflict"
    ? `${field} changed in ${vendor}${d.offer_version ? ` (offer version ${d.offer_version})` : ""}: Weft has ${syncValue(d.field, d.weft_value)}, ${vendor} has ${syncValue(d.field, d.vendor_value)}.${payChange ? " Pay changes are applied from People so payroll previews them." : ""}`
    : s.kind === "unmapped_value" ? `${field} ${d.ext_name ? `"${d.ext_name}"` : ""} is not mapped. ${d.reason ?? ""}`
      : d.reason ?? KIND_LABEL[s.kind];
  return (
    <li data-testid={H.syncItem(s.id)} data-kind={s.kind} data-subject={s.subjectRef} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-[13px]">
      <Badge tone={s.kind === "sync_conflict" ? "amber" : "gray"} size="md">{KIND_LABEL[s.kind] ?? s.kind}</Badge>
      <div className="min-w-[220px] flex-1">
        <div>{text}</div>
        <div className="text-1 text-gray-10" title={s.subjectRef}>{vendor}{simulated ? " (sim)" : ""} · {syncSubject(s.subjectRef, offers)} · opened {fmtDateTime(s.createdAt)}</div>
      </div>
      <Button size="sm" variant="secondary" data-testid={H.syncResolve(s.id, "weft")} disabled={resolve.pending} onClick={() => void resolve.run("weft")}>Keep Weft value</Button>
      {s.kind === "sync_conflict" && !payChange ? <Button size="sm" variant="primary" data-testid={H.syncResolve(s.id, "vendor")} disabled={resolve.pending} onClick={() => void resolve.run("vendor")}>Take {vendor} value</Button> : null}
      {resolve.error ? <span role="alert" className="w-full text-1 text-red-11">{errorText(resolve.error)}</span> : null}
    </li>
  );
}

export function IntegrationsView() {
  const cards = useGet("/v1/integrations", { refreshMs: 10_000 });
  const items = useGet("/v1/sync-items", { query: { status: "open" }, refreshMs: 4_000 });
  const jobs = useGet("/v1/ats/jobs", { refreshMs: 30_000 });
  // Not in the typed route table: the same proxy and principal, cast at the edge.
  const importedQ = useGet("/v1/integrations/greenhouse/imported" as never, { refreshMs: 5_000 }) as unknown as { data: Imported[] | undefined };
  const imported = importedQ.data ?? [];
  const wdQ = useGet("/v1/integrations/workday/imported" as never, { refreshMs: 5_000 }) as unknown as { data: WorkdayTimeOff[] | undefined };
  const wdTimeOff = wdQ.data ?? [];
  const list = (cards.data ?? []) as IntegrationCard[];
  const open = (items.data ?? []) as SyncItem[];
  const roles = (jobs.data ?? []) as Job[];
  const offerNames = Object.fromEntries(imported.filter((x) => x.candidate).map((x) => [x.offerId, x.candidate!]));
  const modeOf = (vendor: string) => list.find((c) => c.status.vendor === vendor)?.status.mode ?? "simulated";
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Integrations" subtitle="The HR systems Weft connects to. Each one runs as a simulator until it is connected. Greenhouse, Checkr and DocuSign can be connected with credentials; the real Workday adapter is not built yet and HireRight has no public API." />
      <div data-testid={H.notice} className="mb-4 flex flex-col gap-1 rounded-lg bg-gray-2 px-3 py-2 text-1 text-gray-11">
        <p>Weft never creates vendor accounts or accepts vendor terms for you. Simulated cards use fictional Larkspur data only.</p>
        <p>Weft reads the secret names below from the file named in WEFT_SECRETS_FILE, and real mode also needs WEFT_INTEGRATIONS_REAL=1. DocuSign also needs WEFT_ESIGN=docusign and WEFT_LIVE_DOCUSIGN=1; Checkr production also needs WEFT_LIVE_CHECKR=1. Values never reach the database or this page.</p>
      </div>
      {cards.error ? <p role="alert" className="mb-4 text-[13px] text-red-11">{errorText(cards.error)}</p> : null}
      <div data-testid={T.list} data-tour="integrations-list" data-count={list.length} className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4 [&>*]:min-w-0">
        {list.length === 0 && !cards.error ? <p className="text-[13px] text-gray-10">Loading...</p> : list.map((c) => <VendorCard key={c.status.vendor} card={c} />)}
      </div>
      <div className="mt-6 grid gap-6 laptop:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <div className="flex flex-col gap-6">
          <Card className="p-4" data-testid={T.syncItems}>
            <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Sync items <Badge size="xs">{open.length}</Badge></h2>
            <p className="mb-2 text-1 text-gray-10">Weft never overwrites a value silently. A changed value or a value it cannot map waits here for a person to decide.</p>
            {open.length === 0 ? <p className="text-[13px] text-gray-10">Nothing to decide.</p> : <ul className="flex flex-col divide-y divide-[var(--app-border)]">{open.map((s) => <SyncItemRow key={s.id} s={s} simulated={modeOf(s.vendor) !== "real"} offers={offerNames} />)}</ul>}
          </Card>
          <Card className="p-4" data-testid={H.importedOffers}>
            <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Hires imported as draft offers</h2>
            {imported.length === 0 ? <p className="text-[13px] text-gray-10">No hires imported yet. Simulate one on the Greenhouse card.</p> : (
              <ul className="flex flex-col divide-y divide-[var(--app-border)]">
                {imported.map((o) => (
                  <li key={o.offerId} data-offer={o.offerId} data-status={o.status ?? ""} className="flex flex-wrap items-center gap-x-3 py-2 text-[13px]">
                    <div className="min-w-[200px] flex-1">
                      <div className="font-medium">{o.candidate}</div>
                      <div className="text-gray-10">{o.title} · {o.workState} · starts {o.startDate ? fmtDate(o.startDate) : "unknown"} · Greenhouse application {o.applicationRef}, offer version {o.offerVersion ?? 1}</div>
                    </div>
                    <Badge size="md" tone={o.status === "accepted" ? "green" : o.status === "draft" ? "gray" : "blue"}>{o.status ?? "unknown"}</Badge>
                    <a className="text-1 text-blue-11 hover:underline" href="/app/hiring">Open in Hiring</a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-4" data-testid={H.workdayTimeOff}>
            <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Time off from Workday</h2>
            <p className="mb-2 text-1 text-gray-10">Approved in Workday, read-only in Weft, paid through the same Time Off path as requests made here.</p>
            {wdTimeOff.length === 0 ? <p className="text-[13px] text-gray-10">Nothing imported yet. Approve two days off on the Workday card, then Sync now.</p> : (
              <ul className="flex flex-col divide-y divide-[var(--app-border)]">
                {wdTimeOff.map((t) => (
                  <li key={t.requestId} data-request={t.requestId} data-source="workday" className="flex flex-wrap items-center gap-x-3 py-2 text-[13px]">
                    <div className="min-w-[200px] flex-1">
                      <div className="font-medium">{t.worker}</div>
                      <div className="text-gray-10">{fmtDate(t.date)} · {(t.minutes / 60).toFixed(2)} h · Workday entry {t.entryRef.slice(0, 8)}</div>
                    </div>
                    <Badge size="md" tone="green">{t.status}</Badge>
                    <Badge size="md" tone="outline">Read-only</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card className="h-fit p-4" data-testid={H.jobs}>
          <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Open roles (Greenhouse board{modeOf("greenhouse") === "real" ? "" : ", sim"})</h2>
          <p className="mb-2 text-1 text-gray-10">{modeOf("greenhouse") === "real" ? "Read from the Greenhouse board named by the board token in the secrets file." : "From the simulator. Reading a real board today needs the Harvest credentials and WEFT_INTEGRATIONS_REAL=1, plus a board token."}</p>
          <ul className="flex flex-col gap-2">
            {roles.map((j) => (
              <li key={j.id} className="rounded-lg border border-[var(--app-border)] p-2 text-[13px]">
                <div className="font-medium">{j.name}</div>
                <div className="text-1 text-gray-10">{[j.departmentName, j.officeName, j.location].filter(Boolean).join(" · ")}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
