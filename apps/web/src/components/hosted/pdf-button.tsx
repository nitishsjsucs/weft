"use client";
// PDF buttons (docs/cloudflare/design.md 5.4 and 6.3): the offer letter, the signed agreement and the pay stub,
// rendered from Weft's own templates by Browser Run and served from R2 once rendered. A render counts as a mutation
// at the edge (the human grant), so the request goes through the hosted fetch and its 428 retry. Hosted build only.
import { FileDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@weft/ui/components";
import { HOSTED_PATHS } from "../../../../../packages/contracts/src/ext/cf-hosted";
import type { PdfKind } from "../../../../../packages/contracts/src/ext/cf-extras";
import { apiFetch } from "@/lib/api/client";

export const PDF_LABEL: Record<PdfKind, string> = { offer_letter: "Offer letter PDF", signed_agreement: "Signed agreement PDF", pay_stub: "Pay stub PDF" };

/** GET /api/_hosted/pdf/<kind>/<subject id>. Exported for tests. */
export function pdfPath(kind: PdfKind, subjectId: string): string {
  return `${HOSTED_PATHS.pdf}/${kind}/${encodeURIComponent(subjectId)}`;
}

/** Fetches the PDF and saves it as `<kind>-<id>.pdf`. Exported for tests (they pass a fetch and a saver). */
export async function downloadPdf(kind: PdfKind, subjectId: string, f: typeof fetch = apiFetch, save: (blob: Blob, name: string) => void = saveBlob): Promise<void> {
  const res = await f(pdfPath(kind, subjectId), { headers: { accept: "application/pdf" } });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(j?.message ?? `The PDF could not be made (${res.status}).`);
  }
  save(await res.blob(), `${kind.replace(/_/g, "-")}-${subjectId}.pdf`);
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function PdfButton({ kind, subjectId, size = "sm" }: { kind: PdfKind; subjectId: string; size?: "xs" | "sm" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size={size} data-testid={`hosted-pdf-${kind}`} data-subject={subjectId} disabled={busy} onClick={() => { setBusy(true); setError(null); void downloadPdf(kind, subjectId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }}>
        <FileDown /> {busy ? "Making the PDF..." : PDF_LABEL[kind]}
      </Button>
      {error ? <span role="alert" className="text-1 text-red-11">{error}</span> : null}
    </span>
  );
}
