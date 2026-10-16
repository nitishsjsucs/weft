"use client";
// Integrations (docs/wave3.md 3.1, research/wave3/integrations-hr.md 3.7). Owner: w3-integrations-hr.
// Five cards from GET /v1/integrations: the mode (Simulated or Connected), health, the secret names the real adapter
// needs with present or missing (never a value), the free path, a connection test and, for Greenhouse, the simulator
// demo controls. Below: the sync items people decide (keep the Weft value or take the vendor value), the hires
// imported as draft offers and the open roles. Vendor names say what Weft connects to; no logos.
import { useState } from "react";
import { Badge, Button, Card } from "@weft/ui/components";
import { W3_INTEGRATIONS_HR_TID as H, W3_INTEGRATIONS_TID as T, type ConnectorStatus, type IntegrationCard, type SyncItem } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDate, fmtDateTime } from "../format";
import { PageHeader } from "../page";

const CATEGORY_LABEL: Record<string, string> = { ats: "Applicant tracking", hris: "HR system of record", screening: "Background screening", esign: "E-signature" };
const HEALTH_LABEL: Record<string, string> = { ok: "Healthy", auth_failed: "Sign-in failed", rate_limited: "Rate limited", permission_gap: "Permission gap", unreachable: "Unreachable", not_available: "Not available" };
const KIND_LABEL: Record<string, string> = { sync_conflict: "Conflict", unmapped_value: "Unmapped value", orphaned: "Orphaned", permission_gap: "Permission gap" };
const SIMULATE: Record<string, { kind: string; label: string }[]> = {
  greenhouse: [{ kind: "hire", label: "Simulate a hire" }, { kind: "start_date_change", label: "Change the start date" }, { kind: "redeliver", label: "Resend the last delivery" }],
};
const OWNER_LABEL: Record<string, string> = { people: "People", compensation: "Compensation", time_off: "Time off" };

interface Imported { applicationRef: string; offerVersion: number | null; offerId: string; status: string | null; candidate: string | null; title: string | null; startDate: string | null; workState: string | null }
interface Job { id: string; name: string; departmentName: string | null; officeName: string | null; location: string | null; url: string | null }

function VendorCard({ card }: { card: IntegrationCard }) {
  const v = card.status.vendor;
  const [note, setNote] = useState<string | null>(null);
  const test = useMutation(async () => (await client.post("/v1/integrations/:vendor/test", { params: { vendor: v } })) as ConnectorStatus);
  const sim = useMutation(async (kind: string) => (await client.post("/v1/integrations/:vendor/simulate", { params: { vendor: v }, body: { kind } })) as { summary?: string; data?: { weft_offer_id?: string | null } });
  const sync = useMutation(async () => client.post("/v1/integrations/:vendor/sync", { params: { vendor: v } }));
  const connected = card.status.mode === "real";
  const required = card.secrets.filter((s) => !s.optional), optional = card.secrets.filter((s) => s.optional);
  const err = test.error ?? sim.error ?? sync.error;
  return (
    <Card data-testid={T.card(v)} data-mode={card.status.mode} className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-3 font-medium">{card.title}</h2>
          <p className="text-1 text-gray-10">{CATEGORY_LABEL[card.status.category] ?? card.status.category}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge data-testid={T.mode(v)} tone={connected ? "green" : "gray"} size="md">{connected ? "Connected" : "Simulated"}</Badge>
          <Badge data-testid={H.health(v)} tone={card.status.health === "ok" ? "outline" : "amber"} size="md">{HEALTH_LABEL[card.status.health] ?? card.status.health}</Badge>
        </div>
      </div>
      <p className="text-2 text-gray-12">{card.body}</p>
      {card.ownership ? (
        <p className="text-1 text-gray-11">Owned by {connected ? "Workday" : "Weft"} today: {Object.keys(card.ownership).map((k) => OWNER_LABEL[k] ?? k).join(", ")}.</p>
      ) : null}
      <div className="rounded-lg bg-gray-2 p-3 text-1 text-gray-11">
        <div className="mb-1 font-medium text-gray-12">Free path</div>
        {card.freePath}
      </div>
      <div>
        <div className="mb-1 text-1 font-medium text-gray-10 uppercase">Secrets file</div>
        {required.length === 0 ? <p className="text-1 text-gray-10">No credentials can make this one real yet.</p> : (
          <ul className="flex flex-col gap-1">
            {[...required, ...optional].map((s) => (
              <li key={s.name} data-testid={H.secret(v, s.name)} data-present={s.present ? "yes" : "no"} className="flex items-center justify-between gap-2 text-1">
                <code className="truncate font-mono text-[12px] text-gray-12">{s.name}{s.optional ? " (optional)" : ""}</code>
                <span className={s.present ? "text-green-11" : "text-gray-10"}>{s.present ? "Present" : "Missing"}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-1 text-gray-10">Weft reads these names from the file in WEFT_SECRETS_FILE and real mode also needs WEFT_INTEGRATIONS_REAL=1. Values never reach the database or this page.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" data-testid={T.test(v)} disabled={test.pending} onClick={() => void test.run().then((s) => s && setNote(`Test: ${HEALTH_LABEL[s.health] ?? s.health}${s.detail ? ` (${s.detail.replace(/_/g, " ")})` : ""}`))}>Test connection</Button>
        {v === "greenhouse" || v === "workday" ? <Button size="sm" variant="ghost" disabled={sync.pending} onClick={() => void sync.run().then(() => setNote("Synced"))}>Sync now</Button> : null}
        {!connected ? (SIMULATE[v] ?? []).map((s) => (
          <Button key={s.kind} size="sm" variant={s.kind === "hire" ? "primary" : "secondary"} data-testid={T.simulate(v, s.kind)} disabled={sim.pending}
            onClick={() => void sim.run(s.kind).then((r) => r && setNote(r.summary ?? "Done"))}>{s.label}</Button>
        )) : null}
      </div>
      {note ? <p data-testid={H.testResult(v)} className="text-1 text-gray-11">{note}{card.status.lastSyncAt ? ` · last sync ${fmtDateTime(card.status.lastSyncAt)}` : ""}</p> : null}
      {err ? <p role="alert" className="text-1 text-red-11">{errorText(err)}</p> : null}
    </Card>
  );
}

function SyncItemRow({ s }: { s: SyncItem }) {
  const resolve = useMutation(async (take: "weft" | "vendor") => client.post("/v1/sync-items/:id/resolve", { params: { id: s.id }, body: { take } }));
  const d = s.detail;
  const text = s.kind === "sync_conflict"
    ? `${d.label ?? d.field} changed in Greenhouse (version ${d.offer_version}): Weft has ${d.weft_value}, Greenhouse has ${d.vendor_value}.`
    : s.kind === "unmapped_value" ? `${d.field === "office" ? "Office" : d.field === "department" ? "Department" : d.field} ${d.ext_name ? `"${d.ext_name}"` : ""} is not mapped. ${d.reason ?? ""}`
      : d.reason ?? KIND_LABEL[s.kind];
  return (
    <li data-testid={H.syncItem(s.id)} data-kind={s.kind} data-subject={s.subjectRef} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-[13px]">
      <Badge tone={s.kind === "sync_conflict" ? "amber" : "gray"} size="md">{KIND_LABEL[s.kind] ?? s.kind}</Badge>
      <div className="min-w-[220px] flex-1">
        <div>{text}</div>
        <div className="text-1 text-gray-10">{s.vendor === "greenhouse" ? "Greenhouse (sim)" : s.vendor} · {s.subjectRef} · opened {fmtDateTime(s.createdAt)}</div>
      </div>
      <Button size="sm" variant="secondary" data-testid={H.syncResolve(s.id, "weft")} disabled={resolve.pending} onClick={() => void resolve.run("weft")}>Keep Weft value</Button>
      {s.kind === "sync_conflict" ? <Button size="sm" variant="primary" data-testid={H.syncResolve(s.id, "vendor")} disabled={resolve.pending} onClick={() => void resolve.run("vendor")}>Take Greenhouse value</Button> : null}
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
  const list = (cards.data ?? []) as IntegrationCard[];
  const open = (items.data ?? []) as SyncItem[];
  const roles = (jobs.data ?? []) as Job[];
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Integrations" subtitle="The HR systems Weft connects to. Each one runs as a simulator that follows the vendor's published API until you add credentials and turn real mode on." />
      <p data-testid={H.notice} className="mb-4 rounded-lg bg-gray-2 px-3 py-2 text-1 text-gray-11">Weft never creates vendor accounts or accepts vendor terms for you. Simulated cards use fictional Larkspur data only.</p>
      {cards.error ? <p role="alert" className="mb-4 text-[13px] text-red-11">{errorText(cards.error)}</p> : null}
      <div data-testid={T.list} className="grid gap-4 tablet:grid-cols-2 laptop:grid-cols-3 [&>*]:min-w-0">
        {list.length === 0 && !cards.error ? <p className="text-[13px] text-gray-10">Loading...</p> : list.map((c) => <VendorCard key={c.status.vendor} card={c} />)}
      </div>
      <div className="mt-6 grid gap-6 laptop:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <div className="flex flex-col gap-6">
          <Card className="p-4" data-testid={T.syncItems}>
            <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Sync items <Badge size="xs">{open.length}</Badge></h2>
            <p className="mb-2 text-1 text-gray-10">Weft never overwrites a value silently. A changed value or a value it cannot map waits here for a person to decide.</p>
            {open.length === 0 ? <p className="text-[13px] text-gray-10">Nothing to decide.</p> : <ul className="flex flex-col divide-y divide-[var(--app-border)]">{open.map((s) => <SyncItemRow key={s.id} s={s} />)}</ul>}
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
        </div>
        <Card className="h-fit p-4" data-testid={H.jobs}>
          <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Open roles (Greenhouse board, sim)</h2>
          <p className="mb-2 text-1 text-gray-10">A public job board needs no key; with a board token in the secrets file the real adapter reads it read-only.</p>
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
