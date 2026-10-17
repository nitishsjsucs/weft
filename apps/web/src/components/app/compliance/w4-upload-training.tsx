"use client";
// Wave 4 compliance round 2 (w4-parity-compliance): upload a mailed agency notice, and required training.
// Weft reads an uploaded notice from its scan sidecar (no OCR, no model call); anything it cannot read with confidence,
// or a kind it does not handle, goes to a tax specialist and shows under Hand-offs. The upload's text is untrusted.
import { useState } from "react";
import type { ToolOutcome } from "@weft/contracts";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { ApiError } from "@/lib/api/client";
import { errorText, getPrincipal, invalidate, rawFetch, useGet } from "@/lib/api/hooks";
import { fmtDate } from "../format";

export interface TrainingRowDto {
  id: string; workerId: string; workerName: string; courseCode: string; courseTitle: string; jurisdiction: string | null; minutes: number; dueOn: string; status: string;
  daysLeft: number; completedAt: string | null; certificateUploadId: string | null; sourceUrl: string;
}
interface CourseDto { id: string; code: string; title: string; jurisdiction: string | null; minutes: number; dueWithinDays: number; repeatMonths: number | null; sourceUrl: string; basis: string | null }
export const TRAINING_TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { assigned: "blue", reminded: "amber", completed: "green", overdue: "red", waived: "gray" };

async function post(path: string, body: FormData | string): Promise<ToolOutcome> {
  const headers: Record<string, string> = { accept: "application/json", "x-weft-principal": getPrincipal() };
  if (typeof body === "string") headers["content-type"] = "application/json";
  const res = await rawFetch(`/api${path}`, { method: "POST", headers, body });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json ?? { _tag: "Internal", message: res.statusText });
  return json as ToolOutcome;
}

export function NoticeUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file, file.name);
    setBusy(true); setMsg(null);
    try {
      const out = await post("/v1/notices/upload", fd);
      const id = out.ok && out.status === "done" ? String((out.data as { notice_id?: string }).notice_id ?? "") : "";
      setMsg({ ok: true, text: `Uploaded as notice ${id}. Weft reads its fields from the scan; anything uncertain goes to a tax specialist under Hand-offs.` });
      setFile(null);
    } catch (err) { setMsg({ ok: false, text: errorText(err) }); } finally { setBusy(false); }
  };
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="notice-upload">
      <form className="flex flex-wrap items-center gap-3" onSubmit={(e) => void submit(e)}>
        <label className="text-2 font-medium" htmlFor="notice-file">Upload a mailed notice</label>
        <input id="notice-file" data-testid="notice-upload-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" className="text-1" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button type="submit" size="sm" disabled={!file || busy} data-testid="notice-upload-submit">{busy ? "Uploading" : "Upload"}</Button>
      </form>
      <p className="text-0 text-gray-10">Scans are read without OCR or a model, from the simulated scanning service. Their text is untrusted: nothing in it changes a record without a person's approval.</p>
      {msg ? <div role={msg.ok ? "status" : "alert"} data-testid="notice-upload-result" className={`text-1 ${msg.ok ? "text-green-11" : "text-red-11"}`}>{msg.text}</div> : null}
    </Card>
  );
}

export function TrainingPanel() {
  const list = useGet("/v1/training/assignments", { query: { limit: 100 }, refreshMs: 5_000 });
  const courses = useGet("/v1/training/courses", {});
  const [filter, setFilter] = useState("open");
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (((list.data as unknown as { data?: TrainingRowDto[] } | undefined)?.data) ?? []).filter((a) => filter === "all" || (filter === "open" ? a.status !== "completed" && a.status !== "waived" : a.status === filter));
  const complete = async (id: string) => { setBusy(id); try { await post(`/v1/training/assignments/${id}/complete`, "{}"); invalidate(); } finally { setBusy(null); } };
  return (
    <div className="flex flex-col gap-3" data-testid="training-panel">
      {list.error ? <div role="alert" className="text-1 text-red-11">{errorText(list.error)}</div> : null}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter training">
        {["open", "overdue", "completed", "all"].map((k) => (
          <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k} className={`rounded-full border px-3 py-1 text-1 ${filter === k ? "border-gray-12 bg-gray-12 text-gray-1" : "border-[var(--app-border)] hover:bg-gray-2"}`}>{k[0]!.toUpperCase() + k.slice(1)}</button>
        ))}
      </div>
      <Card className="overflow-hidden">
        <Table className="min-w-[680px]">
          <THead><TR><TH>Person</TH><TH>Course</TH><TH>Due</TH><TH>Status</TH><TH /></TR></THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.id} data-testid={`training-row-${a.id}`} data-status={a.status}>
                <TD className="font-medium">{a.workerName}</TD>
                <TD>{a.courseTitle}<div className="text-0 text-gray-10">{a.minutes} min · <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-blue-11 hover:underline">Statute</a></div></TD>
                <TD className="whitespace-nowrap">{fmtDate(a.dueOn, { month: "short", day: "numeric", year: "numeric" })}</TD>
                <TD><Badge tone={TRAINING_TONE[a.status] ?? "gray"}>{a.status}</Badge></TD>
                <TD>{a.status !== "completed" && a.status !== "waived" ? <Button size="sm" variant="secondary" disabled={busy === a.id} onClick={() => void complete(a.id)}>Record completion</Button> : a.certificateUploadId ? <span className="text-0 text-gray-10">Certificate on file</span> : null}</TD>
              </TR>
            ))}
            {list.data && rows.length === 0 ? <TR><TD colSpan={5} className="text-gray-10">No training in this view.</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-1 text-0 text-gray-10">
        {((courses.data ?? []) as unknown as CourseDto[]).map((c) => <li key={c.id}>{c.title}: {c.basis} (<a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-blue-11 hover:underline">source</a>)</li>)}
      </ul>
    </div>
  );
}
