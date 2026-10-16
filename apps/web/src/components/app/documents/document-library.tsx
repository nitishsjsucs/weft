"use client";
// Per-employee document library (Signed, Sent, Pending). Owner: w2-onboarding (docs/wave2.md). Mounted by people-view.tsx.
import { Card } from "@weft/ui/components";

export function DocumentLibrary({ workerId }: { workerId: string }) {
  return (
    <Card className="p-4" data-worker={workerId}>
      <h2 className="mb-3 text-1 font-medium text-gray-10 uppercase">Documents</h2>
      <p className="text-[13px] text-gray-10">No documents yet.</p>
    </Card>
  );
}
