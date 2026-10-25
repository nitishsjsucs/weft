"use client";
// The hosted shell's overlays (docs/cloudflare/design.md 6.2), mounted once in the root layout on the hosted build:
// the Open my workspace dialog, the human check a 428 asks for, and the lease-ended screen. None of them does
// anything until the session state asks for it, so the landing page still makes no request.
import { Dialog } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@weft/ui/components";
import { closeStart, dismissEnded, grantFailed, HostedRequestError, requestStart, startLease, verifyGrant } from "@/lib/hosted/session";
import { blockedText, HOSTED_COPY as C } from "./copy";
import { TurnstileWidget } from "./turnstile";
import { useHostedState } from "./use-hosted";

const overlay = "fixed inset-0 z-[80] bg-black/20";
const panel = "fixed inset-0 z-[81] m-auto flex h-fit w-[min(460px,calc(100vw-32px))] flex-col gap-3 rounded-xl bg-card p-5 text-[13px] shadow-[var(--shadow-modal)] outline-none";

function errorLine(e: unknown): string {
  if (e instanceof HostedRequestError) {
    if (e.code === "TURNSTILE_FAILED") return C.checkFailed;
    if (e.status === 429) return "Too many tries from this network. Wait a minute and try again.";
    return e.message || C.checkFailed;
  }
  return e instanceof Error ? e.message : String(e);
}

export function StartWorkspaceDialog() {
  const s = useHostedState();
  const router = useRouter();
  const open = s.startReason !== null;
  // check: the widget runs; busy: the lease request is out; done: a refusal or an error is shown with Try again.
  // Tokens are single use, so a new check starts only when the visitor asks for one.
  const [phase, setPhase] = useState<"check" | "busy" | "done">("check");
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setError(null); setPhase("check"); setNonce((n) => n + 1); } }, [open, s.startAsk]);
  const onToken = async (token: string) => {
    setPhase("busy"); setError(null);
    try {
      const r = await startLease(token);
      if (r.status === "leased" && !window.location.pathname.startsWith("/app")) router.push("/app");
    } catch (e) { setError(errorLine(e)); }
    setPhase("done");
  };
  const retry = () => { setError(null); setPhase("check"); setNonce((n) => n + 1); };
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v && phase !== "busy") closeStart(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content data-testid="hosted-start" data-phase={phase} className={panel}>
          <Dialog.Title className="text-[14px] font-semibold text-gray-12">{C.startTitle}</Dialog.Title>
          {s.startReason === "mutation" ? <p className="font-medium text-gray-12">{C.startForMutation}</p> : null}
          <Dialog.Description className="leading-5 text-gray-11">{C.startBody}</Dialog.Description>
          {s.blocked ? <p role="status" data-testid="hosted-start-blocked" data-status={s.blocked.status} className="rounded-lg bg-amber-3 px-3 py-2 leading-5 text-amber-11">{blockedText(s.blocked)}</p> : null}
          {error ? <p role="alert" className="leading-5 text-red-11">{error}</p> : null}
          {phase === "check" ? <><p className="text-1 text-gray-10">{C.startCheck}</p><TurnstileWidget action="lease" nonce={nonce} onToken={(t) => void onToken(t)} onError={(m) => { setError(m); setPhase("done"); }} /></> : null}
          {phase === "busy" ? <p role="status" className="text-1 text-gray-10">{C.starting}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" disabled={phase === "busy"} onClick={() => closeStart()}>{C.keepBrowsing}</Button>
            {phase === "done" ? <Button size="sm" variant="primary" data-testid="hosted-start-retry" onClick={retry}>{C.tryAgain}</Button> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The fresh human check a mutation's 428 asks for; usually it passes without a click and closes itself. */
export function TurnstileHost() {
  const s = useHostedState();
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => { setError(null); setNonce((n) => n + 1); }, [s.grantAsk]);
  if (s.grantAsk === null) return null;
  const onToken = async (token: string) => {
    try { await verifyGrant(token); } catch (e) { setError(errorLine(e)); }
  };
  return (
    <div role="dialog" aria-label={C.grantTitle} data-testid="hosted-grant" className="fixed right-4 bottom-4 z-[82] flex w-[min(340px,calc(100vw-32px))] flex-col gap-2 rounded-xl bg-card p-4 text-[13px] shadow-[var(--shadow-modal)]">
      <div className="font-semibold text-gray-12">{C.grantTitle}</div>
      <p className="leading-5 text-gray-11">{C.grantBody}</p>
      {error ? <p role="alert" className="text-red-11">{error}</p> : <TurnstileWidget action="grant" appearance="interaction-only" nonce={nonce} onToken={(t) => void onToken(t)} onError={setError} />}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => grantFailed("The check was cancelled.")}>{C.grantCancel}</Button>
        {error ? <Button size="sm" variant="primary" onClick={() => { setError(null); setNonce((n) => n + 1); }}>{C.tryAgain}</Button> : null}
      </div>
    </div>
  );
}

export function LeaseEndedDialog() {
  const s = useHostedState();
  const open = s.ended !== null;
  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content data-testid="hosted-ended" data-reason={s.ended ?? ""} className={panel} onEscapeKeyDown={(e) => { e.preventDefault(); dismissEnded(); }}>
          <Dialog.Title className="text-[14px] font-semibold text-gray-12">{C.endedTitle}</Dialog.Title>
          <Dialog.Description className="leading-5 text-gray-11">{s.ended === "expired" ? C.endedExpired : C.endedServer}</Dialog.Description>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" onClick={() => dismissEnded()}>{C.endedBrowse}</Button>
            <Button size="sm" variant="primary" onClick={() => { dismissEnded(); requestStart("button"); }}>{C.endedAgain}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function HostedRoot() {
  return <><StartWorkspaceDialog /><TurnstileHost /><LeaseEndedDialog /></>;
}
