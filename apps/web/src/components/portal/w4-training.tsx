"use client";
// Portal: the signed-in person's required training (wave 4 T11, owner w4-parity-compliance). Lists their own
// assignments and records completion; Weft issues a completion certificate when none is uploaded.
import { useState } from "react";
import { Badge, Button, Card } from "@weft/ui/components";
import { ApiError } from "@/lib/api/client";
import { errorText, getPrincipal, invalidate, rawFetch, useGet } from "@/lib/api/hooks";
import { TRAINING_TONE, type TrainingRowDto } from "../app/compliance/w4-upload-training";

export function W4TrainingSection() {
  const mine = useGet("/v1/portal/training", { refreshMs: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = (mine.data ?? []) as unknown as TrainingRowDto[];
  const complete = async (id: string) => {
    setBusy(id); setError(null);
    try {
      const res = await rawFetch(`/api/v1/portal/training/${id}/complete`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-weft-principal": getPrincipal() }, body: "{}" });
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null)) ?? { _tag: "Internal", message: res.statusText });
      invalidate();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  return (
    <section data-testid="portal-training" className="flex flex-col gap-3">
      <h2 className="text-4 font-semibold">Training</h2>
      {error ? <div role="alert" className="text-1 text-red-11">{error}</div> : null}
      {mine.data && rows.length === 0 ? <p className="text-2 text-gray-10">No required training right now.</p> : null}
      {rows.map((a) => (
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
