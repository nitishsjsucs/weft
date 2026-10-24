"use client";
// The model switch on the Simulators page (docs/cloudflare/design.md 5.2): which provider new agent runs in this
// visitor's workspace use. It writes the per-world setting through PUT /api/_hosted/model; a run keeps the
// provider it was created with. Hosted build only.
import { Cpu } from "lucide-react";
import { useState } from "react";
import { Card, CardHeading } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { HOSTED_PATHS, type ModelSwitchBody } from "../../../../../packages/contracts/src/ext/cf-hosted";
import type { HostedProviderId } from "../../../../../packages/contracts/src/ext/cf-agent";
import { apiFetch } from "@/lib/api/client";
import { refreshSession } from "@/lib/hosted/session";
import { providerLabel, providerNote } from "./copy";
import { useHostedState } from "./use-hosted";

export const MODEL_CHOICES: { id: HostedProviderId | null; note: string }[] = [
  { id: null, note: "OpenAI gpt-5.6-luna through AI Gateway, unless Weft's settings say otherwise." },
  { id: "openai", note: "Through Cloudflare AI Gateway, with logs and caching. Metered against the spend caps." },
  { id: "workers_ai", note: "Runs on Cloudflare Workers AI. Metered in neurons against the daily allowance." },
  { id: "scripted", note: "Canned answers from the scripted provider. No model calls and no spend." },
];

/** PUT /api/_hosted/model. Exported for tests. */
export async function switchModel(provider: HostedProviderId | null, f: typeof fetch = apiFetch): Promise<void> {
  const body: ModelSwitchBody = { provider };
  const res = await f(HOSTED_PATHS.modelSwitch, { method: "PUT", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(j?.message ?? res.statusText);
  }
}

export function ModelSwitchSection() {
  const s = useHostedState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The choice shows at once; the session read after the PUT confirms it (or the error clears it).
  const [picked, setPicked] = useState<{ id: HostedProviderId | null } | null>(null);
  const status = s.status;
  const leased = status?.world === "slot";
  const worldChoice: HostedProviderId | null = status?.provider.reason === "world" ? status.provider.id : null;
  const note = status ? providerNote(status.provider, status.agentEnabled) : null;
  const choose = async (id: HostedProviderId | null) => {
    setBusy(String(id)); setError(null); setPicked({ id });
    try { await switchModel(id); await refreshSession(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); setPicked(null); }
  };
  return (
    <section className="@min-[68rem]:col-span-2" data-testid="hosted-model-switch">
      <CardHeading icon={<Cpu />}>Model for new agent runs</CardHeading>
      <Card className="divide-y divide-[var(--app-border)]">
        {MODEL_CHOICES.map((c) => {
          const on = (picked ? picked.id : worldChoice) === c.id;
          return (
            <label key={String(c.id)} className={cn("flex items-start gap-3 px-4 py-2.5", leased ? "cursor-pointer" : "opacity-60")}>
              <input type="radio" name="hosted-model" className="mt-1 size-4 accent-[var(--accent-9)]" data-provider={String(c.id)} checked={on} disabled={!leased || busy !== null} onChange={() => void choose(c.id)} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{providerLabel(c.id)}{busy === String(c.id) ? " (saving...)" : ""}</span>
                <span className="block text-1 text-gray-10">{c.note}</span>
              </span>
            </label>
          );
        })}
      </Card>
      <p className="mt-2 text-1 text-gray-11" data-testid="hosted-model-current">
        {status ? `New runs use ${providerLabel(status.provider.id)}.` : "Reading the settings..."} {leased ? "A run keeps the model it started with." : "Open your workspace to choose the model."}
      </p>
      {note ? <p className="mt-1 text-1 text-amber-11">{note}</p> : null}
      {error ? <p role="alert" className="mt-1 text-1 text-red-11">{error}</p> : null}
    </section>
  );
}
