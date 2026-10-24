"use client";
// Hiring: the offer builder (draft, send, void) and the email simulator outbox. Owner: w2-onboarding (docs/wave2.md).
// Every button runs an onboarding.* command through the executor, which writes the action row.
import { useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Card } from "@weft/ui/components";
import { formatCents, W2_ONBOARDING_TID as T, type W2OnboardingOfferDetail } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { useCan } from "@/lib/api/access";
import { fmtDate, fmtDateTime } from "../format";
import { PageHeader } from "../page";
import { OfferScreening } from "../screening/offer-screening";
import { HOSTED } from "@/lib/hosted/flags";
import { PdfButton } from "../../hosted/pdf-button";

const DEPTS = [["dpt_engineering", "Engineering"], ["dpt_hardware", "Hardware"], ["dpt_operations", "Operations"], ["dpt_people", "People"], ["dpt_finance", "Finance"], ["dpt_gtm", "Go-to-market"]] as const;
const STATES = ["CO", "CA", "NY", "TX"] as const;
const STATUS_LABEL: Record<string, string> = { draft: "Draft", sent: "Sent", viewed: "Viewed", accepted: "Accepted", voided: "Void", expired: "Expired" };
const STATUS_TONE: Record<string, "gray" | "blue" | "green" | "amber"> = { draft: "gray", sent: "blue", viewed: "blue", accepted: "green", voided: "gray", expired: "amber" };
interface Email { id: string; to: string; subject: string; body: string; kind: string; relatedRef: string | null; ts: string }

const field = "h-8 w-full rounded-lg border border-[var(--app-border)] bg-card px-2.5 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";

/** Declared at module scope: a component declared inside OfferForm would remount its input on every keystroke. */
function L({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-1 text-gray-11">{label}{children}</label>;
}

function OfferForm() {
  const [f, setF] = useState({ candidateFirst: "", candidateLast: "", candidateEmail: "", title: "", departmentId: "dpt_hardware", workState: "CO", base: "", startDate: "2026-11-16" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation(async () => client.post("/v1/offers", { body: { candidateFirst: f.candidateFirst, candidateLast: f.candidateLast, candidateEmail: f.candidateEmail, title: f.title, departmentId: f.departmentId, workState: f.workState, baseCents: Math.round(Number(f.base.replace(/[$,]/g, "")) * 100), payKind: "salary", startDate: f.startDate } }));
  const [saved, setSaved] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const out = (await save.run()) as { ok?: boolean; data?: { offer_id: string } } | undefined;
    if (out?.data?.offer_id) { setSaved(`${f.candidateFirst} ${f.candidateLast}`); setF((x) => ({ ...x, candidateFirst: "", candidateLast: "", candidateEmail: "", title: "", base: "" })); }
  };
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-1 font-medium text-gray-10 uppercase">New offer</h2>
      <form data-testid={T.offerForm} onSubmit={(e) => void submit(e)} className="grid gap-3 tablet:grid-cols-2">
        <L label="First name"><input required data-testid={T.offerFirst} className={field} value={f.candidateFirst} onChange={set("candidateFirst")} /></L>
        <L label="Last name"><input required data-testid={T.offerLast} className={field} value={f.candidateLast} onChange={set("candidateLast")} /></L>
        <L label="Personal email (*.example)"><input required data-testid={T.offerEmail} className={field} placeholder="name@candidate.example" value={f.candidateEmail} onChange={set("candidateEmail")} /></L>
        <L label="Title"><input required data-testid={T.offerTitle} className={field} value={f.title} onChange={set("title")} /></L>
        <L label="Department"><select data-testid={T.offerDepartment} className={field} value={f.departmentId} onChange={set("departmentId")}>{DEPTS.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></L>
        <L label="Work state"><select data-testid={T.offerState} className={field} value={f.workState} onChange={set("workState")}>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</select></L>
        <L label="Base salary (USD a year)"><input required inputMode="decimal" data-testid={T.offerBase} className={field} placeholder="132000" value={f.base} onChange={set("base")} /></L>
        <L label="Start date"><input required type="date" data-testid={T.offerStart} className={field} value={f.startDate} onChange={set("startDate")} /></L>
        <div className="flex items-center gap-3 tablet:col-span-2">
          <Button type="submit" variant="primary" disabled={save.pending} data-testid={T.offerSaveDraft}>Save draft</Button>
          {save.error ? <span role="alert" className="text-1 text-red-11">{errorText(save.error)}</span> : saved ? <span className="text-1 text-gray-11">Draft saved for {saved}. The manager defaults to the department lead.</span> : <span className="text-1 text-gray-10">Drafts are not sent until you press Send.</span>}
        </div>
      </form>
    </Card>
  );
}

/**
 * The hosted PDF buttons an offer shows, both for its offer letter document (`documentId`, a doc_ id: the PDF route
 * reads documents, not offers): the offer letter once sent, and the signed agreement once accepted. An offer without
 * a document (a seeded one can have none) shows neither.
 */
export function offerPdfs(o: Pick<W2OnboardingOfferDetail, "status" | "documentId">): { kind: "offer_letter" | "signed_agreement"; subjectId: string }[] {
  if (!o.documentId || o.status === "draft" || o.status === "voided") return [];
  return o.status === "accepted"
    ? [{ kind: "offer_letter", subjectId: o.documentId }, { kind: "signed_agreement", subjectId: o.documentId }]
    : [{ kind: "offer_letter", subjectId: o.documentId }];
}

function OfferRow({ o }: { o: W2OnboardingOfferDetail }) {
  const send = useMutation(async () => client.post("/v1/offers/:id/send", { params: { id: o.id } }));
  const voidIt = useMutation(async () => client.post("/v1/offers/:id/void", { params: { id: o.id } }));
  const edit = useCan()("people", "edit");   // Send and Void need people edit; a manager only reads
  const [confirmVoid, setConfirmVoid] = useState(false);
  const err = send.error ?? voidIt.error;
  return (
    <li data-testid={T.offerRow} data-tour="hiring-offer" data-offer={o.id} data-status={o.status} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-[13px]">
      <div className="min-w-[200px] flex-1">
        <div className="font-medium">{o.candidateFirst} {o.candidateLast}</div>
        <div className="text-gray-10">{o.title} · {o.workState}{o.baseCents === null ? "" : ` · ${formatCents(o.baseCents)}`} · starts {fmtDate(o.startDate)}{o.expiresOn ? ` · open until ${fmtDate(o.expiresOn)}` : ""}</div>
      </div>
      <Badge data-testid={T.offerStatus} data-status={o.status} tone={STATUS_TONE[o.status] ?? "gray"} size="md">{STATUS_LABEL[o.status] ?? o.status}</Badge>
      {edit && o.allowed.includes("sent") ? <Button size="sm" variant="primary" data-testid={T.offerSend} disabled={send.pending} onClick={() => void send.run()}>Send</Button> : null}
      {edit && o.allowed.includes("voided") && !confirmVoid ? <Button size="sm" variant="secondary" data-testid={T.offerVoid} onClick={() => setConfirmVoid(true)}>Void</Button> : null}
      {o.allowed.includes("voided") && confirmVoid ? (
        <span className="flex items-center gap-2">
          <span className="text-1 text-gray-11">The candidate's portal link stops working.</span>
          <Button size="sm" variant="danger" data-testid="offer-void-confirm" disabled={voidIt.pending} onClick={() => void voidIt.run().then(() => setConfirmVoid(false))}>Void offer</Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirmVoid(false)}>Cancel</Button>
        </span>
      ) : null}
      {o.personaPrincipalId && (o.status === "sent" || o.status === "viewed" || o.status === "accepted") ? <a data-testid={T.offerPortalLink} className="text-1 text-blue-11 hover:underline" href={`/portal?as=${o.personaPrincipalId}`}>Open portal as new hire</a> : null}
      {HOSTED ? offerPdfs(o).map((p) => <PdfButton key={p.kind} kind={p.kind} subjectId={p.subjectId} size="xs" />) : null}
      {err ? <span role="alert" className="w-full text-1 text-red-11">{errorText(err)}</span> : null}
      <OfferScreening offerId={o.id} accepted={o.status === "accepted"} />
    </li>
  );
}

export function HiringView() {
  const offers = useGet("/v1/offers", { query: { limit: 100 }, refreshMs: 5_000 });
  const mail = useGet("/v1/sim/email", { refreshMs: 5_000 });
  const rows = ((offers.data?.data ?? []) as unknown as W2OnboardingOfferDetail[]).slice().sort((a, b) => (a.id < b.id ? 1 : -1));
  const inbox = ((mail.data ?? []) as Email[]).slice().reverse();
  return (
    <div data-testid={T.hiringPage} className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Hiring" subtitle="Build an offer, send it with a portal invite, and watch the new hire sign and finish their checklist." />
      <div className="grid gap-6 laptop:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <div className="flex flex-col gap-6">
          <OfferForm />
          <Card className="p-4" data-tour="hiring-offers" data-count={rows.length}>
            <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Offers <Badge size="xs">{rows.length}</Badge></h2>
            {offers.error ? <p role="alert" className="text-[13px] text-red-11">{errorText(offers.error)}</p> : null}
            <ul className="flex flex-col divide-y divide-[var(--app-border)]">{rows.map((o) => <OfferRow key={o.id} o={o} />)}</ul>
          </Card>
        </div>
        <Card className="h-fit p-4" data-testid={T.outbox} data-tour="hiring-outbox" data-count={inbox.length}>
          <h2 className="mb-1 text-1 font-medium text-gray-10 uppercase">Email outbox</h2>
          <p className="mb-3 text-1 text-gray-10">Mail to *.example addresses. Nothing leaves this machine.</p>
          {inbox.length === 0 ? <p className="text-[13px] text-gray-10">No mail yet.</p> : (
            <ul className="flex flex-col gap-3">
              {inbox.map((m) => {
                const link = /\/portal\?as=usr_\d+/.exec(m.body)?.[0] ?? null;
                return (
                  <li key={m.id} data-testid={T.outboxItem} data-kind={m.kind} data-ref={m.relatedRef ?? ""} className="rounded-lg border border-[var(--app-border)] p-3 text-[13px]">
                    <div className="font-medium">{m.subject}</div>
                    <div className="text-1 text-gray-10"><span className="break-all">To {m.to}</span> · <span className="whitespace-nowrap">{fmtDateTime(m.ts)}</span></div>
                    {link ? <a className="mt-1 inline-block text-1 text-blue-11 hover:underline" href={link}>Open the new-hire portal</a> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
