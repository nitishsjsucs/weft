"use client";
// Portal: the signed-in person's required training (wave 4 T11, owner w4-parity-compliance). Lists their own
// assignments and records completion; Weft issues a completion certificate when none is uploaded.
// Every call goes out as the portal persona (`principal`), never the admin "Viewing as" principal, so a new hire
// sees and completes only their own assignments.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "@weft/ui/components";
import { createClient } from "@/lib/api/client";
import { errorText } from "@/lib/api/hooks";
import { TRAINING_TONE, type TrainingRowDto } from "../app/compliance/w4-upload-training";

export function W4TrainingSection({ principal }: { principal: string }) {
  const api = useMemo(() => createClient({ principal: () => principal || null }), [principal]);
  const [rows, setRows] = useState<TrainingRowDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRows((await api.get("/v1/portal/training")) as unknown as TrainingRowDto[]); } catch (e) { setError(errorText(e)); }
  }, [api]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);
  const complete = async (id: string) => {
    setBusy(id); setError(null);
    try {
      await api.post("/v1/portal/training/:id/complete", { params: { id }, body: {} });
      await load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  return (
    <section data-testid="portal-training" className="flex flex-col gap-3">
      <h2 className="text-4 font-semibold">Training</h2>
      {error ? <div role="alert" className="text-1 text-red-11">{error}</div> : null}
      {rows && rows.length === 0 ? <p className="text-2 text-gray-10">No required training right now.</p> : null}
      {(rows ?? []).map((a) => (
        <Card key={a.id} className="flex flex-wrap items-center gap-3 p-4" data-testid={`portal-training-${a.id}`}>
          <div className="min-w-0 flex-1">
            <div className="text-2 font-medium">{a.courseTitle}</div>
            <div className="text-1 text-gray-10">{a.minutes} minutes · due {a.dueOn} · <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-blue-11 hover:underline">why this is required</a></div>
          </div>
          <Badge tone={TRAINING_TONE[a.status] ?? "gray"}>{a.status}</Badge>
          {a.status !== "completed" && a.status !== "waived" ? <Button size="sm" disabled={busy === a.id} onClick={() => void complete(a.id)}>I finished this course</Button> : null}
        </Card>
      ))}
    </section>
  );
}
