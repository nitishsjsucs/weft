"use client";
// PDF buttons (docs/cloudflare/design.md 5.4 and 6.3): the offer letter, the signed agreement and the pay stub,
// rendered from Weft's own templates by Browser Run and served from R2 once rendered. A render counts as a mutation
// at the edge (the human grant), so the request goes through the hosted fetch and its 428 retry. A document not
// rendered yet answers 202 while its render job runs, so the button polls (as long as the answer asks, for about a
// minute at most); a refusal (413 too large, 503 failed, budget spent or switched off) ends it with its message.
// Hosted build only.
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

/** The longest the button waits for a render in all; the route asks for 5 s between polls, so about 12 polls. */
export const PDF_WAIT_MAX_MS = 60_000;
const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 15_000;
const POLL_DEFAULT_MS = 5_000;

/** The wait a 202 asks for: the body's retryAfterS, else the Retry-After seconds, else 5 s, kept within 1 to 15 s. Exported for tests. */
export function pdfRetryMs(body: unknown, retryAfter: string | null): number {
  const fromBody = (body as { retryAfterS?: unknown } | null)?.retryAfterS;
  const s = typeof fromBody === "number" ? fromBody : retryAfter !== null && retryAfter.trim() !== "" ? Number(retryAfter) : NaN;
  const ms = Number.isFinite(s) && s > 0 ? s * 1000 : POLL_DEFAULT_MS;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, ms));
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * Fetches the PDF, polling while the route answers 202, and saves it as `<kind>-<id>.pdf`. Only an application/pdf
 * body is saved. Exported for tests (they pass a fetch, a saver and a wait).
 */
export async function downloadPdf(
  kind: PdfKind, subjectId: string, f: typeof fetch = apiFetch, save: (blob: Blob, name: string) => void = saveBlob, wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  let waited = 0;
  for (;;) {
    const res = await f(pdfPath(kind, subjectId), { headers: { accept: "application/pdf" } });
    if (res.status === 202) {
      const ms = pdfRetryMs(await res.json().catch(() => null), res.headers.get("retry-after"));
      if (waited + ms > PDF_WAIT_MAX_MS) throw new Error("The PDF is still being made. Try again in a minute.");
      await wait(ms);
      waited += ms;
      continue;
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(j?.message ?? `The PDF could not be made (${res.status}).`);
    }
    if (!/^application\/pdf\s*(;|$)/i.test(res.headers.get("content-type") ?? "")) throw new Error("The answer was not a PDF. Try again in a minute.");
    save(await res.blob(), `${kind.replace(/_/g, "-")}-${subjectId}.pdf`);
    return;
  }
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
