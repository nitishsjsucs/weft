"use client";
// Embedded e-signature in the new-hire portal (wave 3, docs/wave3.md). Owner: w3-integrations-screening-esign.
// Only with WEFT_ESIGN=docusign: an offer sent as an envelope refuses the built-in signature with DOMAIN_ESIGN_ENVELOPE,
// so the sign button asks for a fresh one-time signing link and sends the whole page there (embedded signing is a
// full-page redirect, never a frame). With the simulator, that link is the simulated signing page below, which signs or
// declines and then returns to the portal. The built-in path makes exactly the same request as before.
import { useState } from "react";
import { Badge, Button, Card } from "@weft/ui/components";
import { ApiError, type createClient } from "@/lib/api/client";

type Api = ReturnType<typeof createClient>;

/** Signs with the built-in signature; when the offer is an envelope, redirects the full page to its signing link instead. */
export async function signOrRedirect(api: Api, doc: { id: string; sha256: string }, typedName: string): Promise<void> {
  try {
    await api.post("/v1/portal/documents/:id/sign", { params: { id: doc.id }, body: { typedName, documentSha256: doc.sha256 } });
  } catch (e) {
    if (!(e instanceof ApiError) || e.body.code !== "DOMAIN_ESIGN_ENVELOPE") throw e;
    const link = (await api.post("/v1/portal/esign/url", { body: {} })) as { url?: string };
    if (!link.url) throw e;
    window.location.assign(link.url);
    await new Promise(() => undefined);   // the page is leaving; keep the button busy until it does
  }
}

/** The signing link's parameters when the portal is showing the simulated signing page (`/portal?esign=...`). */
export function esignParams(): { envelopeId: string; returnUrl: string } | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const envelopeId = q.get("esign");
  const ret = q.get("return") ?? "/portal";
  // Only a same-site portal path is a valid return; anything else falls back to the portal.
  return envelopeId ? { envelopeId, returnUrl: ret.startsWith("/portal") ? ret : "/portal" } : null;
}

/** The e-signature provider's signing page, simulated: Sign or Decline, then back to the portal. */
export function EsignSigningPage({ api, envelopeId, returnUrl }: { api: Api; envelopeId: string; returnUrl: string }) {
  const [busy, setBusy] = useState<"signed" | "declined" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const finish = async (outcome: "signed" | "declined") => {
    setBusy(outcome); setErr(null);
    try {
      await api.post("/v1/portal/esign/finish", { body: { envelopeId, outcome } });
      window.location.assign(returnUrl);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null); }
  };
  return (
    <Card className="p-6" data-testid="esign-signing-page" data-envelope={envelopeId}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-1 font-medium uppercase tracking-wide text-gray-10">E-signature provider signing page (sandbox)</p>
        <Badge tone="gray">Sandbox</Badge>
      </div>
      <h1 className="mt-2 text-5 font-semibold">Review and sign your offer</h1>
      <p className="mt-2 text-2 text-gray-11">This envelope holds two documents: the offer letter and the confidentiality and invention assignment agreement. Signing accepts the offer; declining ends it.</p>
      <ol className="mt-4 flex flex-col gap-2 text-2">
        <li className="rounded-lg bg-gray-2 px-3 py-2">1. Offer letter</li>
        <li className="rounded-lg bg-gray-2 px-3 py-2">2. Confidentiality and invention assignment agreement</li>
      </ol>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" size="lg" disabled={busy !== null} data-testid="esign-sign" onClick={() => void finish("signed")}>{busy === "signed" ? "Signing..." : "Sign both documents"}</Button>
        <Button variant="secondary" size="lg" disabled={busy !== null} data-testid="esign-decline" onClick={() => void finish("declined")}>{busy === "declined" ? "Declining..." : "Decline"}</Button>
      </div>
      {err ? <p role="alert" className="mt-3 text-2 text-red-11">{err}</p> : null}
    </Card>
  );
}
