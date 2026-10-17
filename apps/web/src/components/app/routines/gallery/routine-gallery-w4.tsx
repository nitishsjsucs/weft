"use client";
// Routine gallery (wave 4, w4-parity-admin; G10, G7, G8): every routine with who created it, when it was enabled, its
// last and next run, and how often people approved or overrode its proposals (GET /v1/routine-gallery). A table from
// tablet width up, one card per routine below it, so a phone never scrolls sideways. RoutineDecisionCounts is the
// same data for one routine, shown beside the autonomy control on the routine's page.
import Link from "next/link";
import { Badge, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import type { RoutineGalleryRow } from "@weft/contracts";
import { errorText, useGet } from "@/lib/api/hooks";
import { fmtDateTime } from "../../format";
import { W4_GALLERY_TID } from "./testids";

/** GET /v1/routine-gallery rows: the RoutineGalleryRow contract plus display fields. */
export type GalleryRow = RoutineGalleryRow & { createdByName: string | null; schedule: string; pending: number };


const STATUS_TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = {
  queued: "gray", running: "blue", waiting_approval: "amber", waiting_event: "amber", done: "green", failed: "red", cancelled: "gray", skipped: "gray",
};
const AUTONOMY_LABEL = { recommend: "Recommend", approve: "Approve", auto: "Auto" } as const;

function useGallery() {
  return useGet("/v1/routine-gallery", { refreshMs: 10_000 }) as { data: GalleryRow[] | undefined; error: Error | null };
}

const createdBy = (r: GalleryRow) => (r.source === "prebuilt" ? "Prebuilt" : r.createdByName ?? "Unknown");
const nextRun = (r: GalleryRow) => (r.nextRunAt ? fmtDateTime(r.nextRunAt) : r.enabled ? (r.schedule.startsWith("on ") ? r.schedule : "Manual") : "Off while disabled");

function LastRun({ r }: { r: GalleryRow }) {
  if (!r.lastRunAt) return <span className="text-gray-10">Never</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {r.lastRunStatus ? <Badge tone={STATUS_TONE[r.lastRunStatus] ?? "gray"} size="xs">{r.lastRunStatus.replace("_", " ")}</Badge> : null}
      <span>{fmtDateTime(r.lastRunAt)}</span>
    </span>
  );
}

function Counts({ r }: { r: GalleryRow }) {
  return (
    <span className="inline-flex items-center gap-2 tabular-nums" title="Proposals from this routine's runs that people approved, and that they denied, edited or dismissed">
      <span data-count="approvals" className="text-green-11">{r.approvals} approved</span>
      <span data-count="overrides" className={r.overrides ? "text-amber-11" : "text-gray-10"}>{r.overrides} overridden</span>
    </span>
  );
}

export function RoutineGalleryW4() {
  const g = useGallery();
  const rows = g.data ?? [];
  return (
    <section data-testid={W4_GALLERY_TID.gallery} className="mb-8 min-w-0">
      <h2 className="mb-2 text-3 font-medium">All routines</h2>
      {g.error ? <p role="alert" className="mb-2 text-1 text-red-11">{errorText(g.error)}</p> : null}
      <Card className="hidden overflow-x-auto tablet:block">
        <Table>
          <THead>
            <TR><TH>Routine</TH><TH>Created by</TH><TH>Enabled</TH><TH>Last run</TH><TH>Next run</TH><TH>Autonomy</TH><TH>Decisions</TH></TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.routineId} data-testid={W4_GALLERY_TID.row(r.routineId)} data-next-run={r.nextRunAt ?? ""} data-last-run={r.lastRunAt ?? ""}>
                <TD className="max-w-[240px]"><Link href={`/app/routines/${r.routineId}`} className="font-medium hover:underline">{r.name}</Link><div className="text-0 text-gray-10">{r.schedule}</div></TD>
                <TD className="whitespace-nowrap">{createdBy(r)}</TD>
                <TD className="whitespace-nowrap">{r.enabled ? <>{r.enabledAt ? fmtDateTime(r.enabledAt) : "Yes"}</> : <Badge tone="gray" size="xs">Disabled</Badge>}</TD>
                <TD className="whitespace-nowrap"><LastRun r={r} /></TD>
                <TD className="whitespace-nowrap">{nextRun(r)}</TD>
                <TD className="whitespace-nowrap">{AUTONOMY_LABEL[r.autonomy]}</TD>
                <TD className="whitespace-nowrap"><Counts r={r} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <div className="flex flex-col gap-2 tablet:hidden">
        {rows.map((r) => (
          <Card key={r.routineId} data-testid={W4_GALLERY_TID.card(r.routineId)} className="flex min-w-0 flex-col gap-1 p-3 text-1">
            <div className="flex items-start gap-2">
              <Link href={`/app/routines/${r.routineId}`} className="min-w-0 flex-1 font-medium break-words hover:underline">{r.name}</Link>
              <Badge tone={r.enabled ? "green" : "gray"} size="xs">{r.enabled ? "Enabled" : "Disabled"}</Badge>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-gray-11">
              <dt>Created by</dt><dd className="break-words">{createdBy(r)}</dd>
              {r.enabled && r.enabledAt ? <><dt>Enabled</dt><dd>{fmtDateTime(r.enabledAt)}</dd></> : null}
              <dt>Last run</dt><dd><LastRun r={r} /></dd>
              <dt>Next run</dt><dd className="break-words">{nextRun(r)}</dd>
              <dt>Autonomy</dt><dd>{AUTONOMY_LABEL[r.autonomy]}</dd>
              <dt>Decisions</dt><dd><Counts r={r} /></dd>
            </dl>
          </Card>
        ))}
      </div>
    </section>
  );
}

/** One routine's provenance and decision counts, for the routine page beside the autonomy control. */
export function RoutineDecisionCounts({ routineId }: { routineId: string }) {
  const g = useGallery();
  const r = (g.data ?? []).find((x) => x.routineId === routineId);
  if (!r) return null;
  return (
    <Card data-testid={W4_GALLERY_TID.counts(routineId)} className="p-4 text-1">
      <h2 className="mb-2 text-1 font-medium text-gray-10 uppercase">History</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-gray-11">
        <dt>Created by</dt><dd className="break-words">{createdBy(r)}</dd>
        <dt>Enabled</dt><dd>{r.enabled ? (r.enabledAt ? fmtDateTime(r.enabledAt) : "Yes") : "Disabled"}</dd>
        <dt>Last run</dt><dd><LastRun r={r} /></dd>
        <dt>Next run</dt><dd className="break-words">{nextRun(r)}</dd>
        <dt>Approved</dt><dd className="tabular-nums" data-count="approvals">{r.approvals}</dd>
        <dt>Overridden</dt><dd className="tabular-nums" data-count="overrides">{r.overrides}</dd>
        {r.pending ? <><dt>Waiting</dt><dd className="tabular-nums"><Link href="/app/inbox" className="underline">{r.pending} in the Inbox</Link></dd></> : null}
      </dl>
      <p className="mt-2 text-0 text-gray-10">Overridden counts proposals a person denied, edited or dismissed. They inform the agent only and never change its permissions.</p>
    </Card>
  );
}
