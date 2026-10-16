"use client";
// Per-employee document library (Signed, Sent, Pending). Owner: w2-onboarding (docs/wave2.md). Mounted by people-view.tsx.
// Void documents stay listed under their last tab with a Void badge (wave2.ts DocumentStatus).
import { useState } from "react";
import { Badge, Card, Tabs, TabsContent, TabsList, TabsTrigger } from "@weft/ui/components";
import { W2_ONBOARDING_TID as T, type WorkerDocument } from "@weft/contracts";
import { client, errorText, useGet } from "@/lib/api/hooks";
import { fmtDate, fmtDateTime } from "../format";

const TABS = [["signed", "Signed"], ["sent", "Sent"], ["pending", "Pending"]] as const;
const tabOf = (d: WorkerDocument): "signed" | "sent" | "pending" => (d.status === "voided" ? (d.sentAt ? "sent" : "pending") : d.status === "signed" ? "signed" : d.status === "sent" ? "sent" : "pending");

interface DocDetail extends WorkerDocument { bodyText: string; signature: { signerName: string; typedName: string; signedAt: string; documentSha256: string; actionSeq: number | null } | null }

export function DocumentLibrary({ workerId }: { workerId: string }) {
  const q = useGet("/v1/workers/:id/documents", { params: { id: workerId }, refreshMs: 5_000 });
  const docs = (q.data ?? []) as WorkerDocument[];
  const [tab, setTab] = useState<string>("signed");
  const [open, setOpen] = useState<DocDetail | null>(null);
  const show = async (id: string) => setOpen((await client.get("/v1/documents/:id", { params: { id } })) as DocDetail);
  return (
    <Card className="p-4" data-worker={workerId} data-testid={T.docLibrary}>
      <h2 className="mb-3 text-1 font-medium text-gray-10 uppercase">Documents</h2>
      {q.error ? <p role="alert" className="text-[13px] text-red-11">{errorText(q.error)}</p> : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map(([k, label]) => <TabsTrigger key={k} value={k} data-testid={`${T.docTab}-${k}`}>{label} <Badge size="xs">{docs.filter((d) => tabOf(d) === k).length}</Badge></TabsTrigger>)}
        </TabsList>
        {TABS.map(([k]) => {
          const rows = docs.filter((d) => tabOf(d) === k);
          return (
            <TabsContent key={k} value={k}>
              {rows.length === 0 ? <p className="text-[13px] text-gray-10">{q.loading && !q.data ? "Loading..." : "No documents here."}</p> : (
                <ul className="flex flex-col divide-y divide-[var(--app-border)]">
                  {rows.map((d) => (
                    <li key={d.id} data-testid={T.docRow} data-kind={d.kind} data-status={d.status} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                      <button type="button" className="min-w-0 flex-1 text-left font-medium break-words hover:underline tablet:truncate" onClick={() => void show(d.id)}>{d.title}</button>
                      {d.status === "voided" ? <Badge size="xs">Void</Badge> : null}
                      <span className="text-gray-10">{d.signedAt ? `Signed ${fmtDate(d.signedAt)}` : d.sentAt ? `Sent ${fmtDate(d.sentAt)}` : `Created ${fmtDate(d.createdAt)}`}</span>
                      <code className="hidden font-mono text-1 text-gray-10 tablet:inline" title={d.sha256}>{d.sha256.slice(0, 10)}</code>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
      {open ? (
        <div className="mt-4 rounded-lg border border-[var(--app-border)] p-3">
          <div className="mb-2 flex items-center gap-2"><span className="flex-1 text-2 font-medium">{open.title}</span><button type="button" className="text-1 text-gray-10 hover:underline" onClick={() => setOpen(null)}>Close</button></div>
          {open.signature ? <p className="mb-2 text-1 text-gray-11">Signed by {open.signature.signerName} as "{open.signature.typedName}" at {fmtDateTime(open.signature.signedAt)}, sha256 <code className="font-mono">{open.signature.documentSha256.slice(0, 16)}</code>, action #{open.signature.actionSeq ?? "-"}</p> : null}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-1 text-gray-11">{open.bodyText}</pre>
        </div>
      ) : null}
    </Card>
  );
}
