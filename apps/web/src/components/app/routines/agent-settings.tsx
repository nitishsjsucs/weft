"use client";
// Settings > Agent (wave 3, w3-parity-routines): the two company switches, both off by default. Only an admin in the
// UI session can change them (PUT /v1/settings/agent is ui_only and audited as an action row).
import { Card } from "@weft/ui/components";
import { W3_ROUTINES_TID } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import type { AgentSettings } from "./autonomy-control";

const ROWS: { key: keyof AgentSettings; tid: string; title: string; detail: string }[] = [
  { key: "chatCanPropose", tid: W3_ROUTINES_TID.settingChatCanPropose, title: "Chat can propose changes",
    detail: "When on, asking the agent in chat to pay, approve or decide something files a proposal for a person to approve. Chat never executes a change itself." },
  { key: "allowAutoAutonomy", tid: W3_ROUTINES_TID.settingAllowAutoAutonomy, title: "Allow auto autonomy for routines",
    detail: "When on, a routine set to Auto may run commands that opt in, under their limit, in a clean run. Money movement and admin access always wait for approval." },
];

export function AgentSettingsCard() {
  const q = useGet("/v1/settings/agent") as { data: AgentSettings | undefined; error: Error | null };
  const save = useMutation((patch: Partial<AgentSettings>) => client.put("/v1/settings/agent", { body: patch }));
  return (
    <Card className="p-0" data-testid={W3_ROUTINES_TID.settingsAgent}>
      <div className="border-b border-[var(--app-border)] px-4 py-3">
        <h2 className="text-3 font-medium">Agent</h2>
        <p className="text-[13px] text-gray-11">How far the agent may go on its own. Both start off.</p>
      </div>
      <ul>
        {ROWS.map((r) => {
          const on = q.data?.[r.key] === true;
          return (
            <li key={r.key} className="flex items-start gap-4 border-b border-[var(--app-border)] px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="text-2 font-medium">{r.title}</div>
                <p className="text-[13px] leading-5 text-gray-11">{r.detail}</p>
              </div>
              <button type="button" role="switch" aria-checked={on} aria-label={r.title} data-testid={r.tid} disabled={!q.data || save.pending}
                onClick={() => void save.run({ [r.key]: !on })}
                className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] focus-visible:ring-offset-1 disabled:opacity-50 ${on ? "bg-gray-12" : "bg-gray-5"}`}>
                <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
              </button>
            </li>
          );
        })}
      </ul>
      {q.error ? <p role="alert" className="px-4 pb-3 text-1 text-red-11">{errorText(q.error)}</p> : null}
      {save.error ? <p role="alert" className="px-4 pb-3 text-1 text-red-11">{errorText(save.error)}</p> : null}
    </Card>
  );
}
