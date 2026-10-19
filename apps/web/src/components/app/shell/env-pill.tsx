"use client";
// The environment pill (D2): model, then simulated clock, then Viewing as, in one white container. Each segment opens
// its own popover or menu (research/wave3/topbar-design.md 5.3 to 5.6).
import Link from "next/link";
import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, W3_SHELL_TID } from "@weft/contracts";
import { client, errorText, useGet, useHealth, useMutation, useSimClock } from "@/lib/api/hooks";
import { fmtClock, fmtShortClock } from "../format";
import { clockAria, fmtLongClock, fmtUsd, MODE_LABEL, modelAria, modelLabel, modelState, nextRoutineSlot, rateLabel, type ModelState } from "./env";
import { PersonaMenu } from "./persona-menu";
import { dividerClass, pillClass, segmentClass } from "./segment";

const DOT: Record<ModelState, string> = {
  live: "bg-[var(--status-live)]",
  local: "bg-[var(--status-local)]",
  scripted: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--gray-8)]",
  offline: "bg-[var(--status-off)]",
  loading: "bg-gray-6 motion-safe:animate-pulse",
};

function StatusDot({ state }: { state: ModelState }) {
  return <span aria-hidden data-state-dot={state} className={cn("size-2 shrink-0 rounded-full", DOT[state])} />;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="w-[88px] shrink-0 text-gray-11">{k}</span>
      <span className="min-w-0 flex-1 tabular text-gray-12">{children}</span>
    </div>
  );
}

interface Costs { day: string; daySpentUsd: number; liveSpentUsd: number }

function ModelSegment() {
  const health = useHealth();
  const provider = health.data?.provider;
  const state = modelState(provider, !!health.error && !health.data);
  const [open, setOpen] = useState(false);
  const costs = useGet("/v1/agent/costs", { enabled: open });
  const c = costs.data as Costs | undefined;

  // Announce a model state change (live to offline and back) to screen readers.
  const [said, setSaid] = useState("");
  const prev = useRef<ModelState>(state);
  useEffect(() => {
    if (prev.current !== "loading" && state !== "loading" && prev.current !== state) setSaid(modelAria(provider, state));
    prev.current = state;
  }, [state, provider]);

  return (
    <>
      <span className="sr-only" aria-live="polite">{said}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-seg=""
          data-testid={TID.providerBadge}
          data-model-state={state}
          aria-label={modelAria(provider, state)}
          className={cn(segmentClass, "w-7 justify-center px-0 @min-[480px]:w-auto @min-[480px]:justify-start @min-[480px]:px-2")}
        >
          <StatusDot state={state} />
          {state === "loading" ? (
            <span aria-hidden className="hidden h-2.5 w-14 rounded-sm bg-gray-3 @min-[480px]:block" />
          ) : (
            <>
              <span className="hidden @min-[760px]:inline">{modelLabel(provider, state, "full")}</span>
              <span className="hidden @min-[480px]:inline @min-[760px]:hidden">{modelLabel(provider, state, "compact")}</span>
            </>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Model" data-testid={W3_SHELL_TID.modelPopover} className="motion-reduce:data-[state=open]:animate-none">
          <div className="flex items-center gap-2 pb-1.5 font-semibold text-gray-12">
            <StatusDot state={state} />
            <span className="min-w-0 truncate">{state === "offline" ? "API offline" : provider?.label ?? "Checking the model"}</span>
          </div>
          <Row k="Mode">{MODE_LABEL[state]}</Row>
          {provider?.model ? <Row k="Model id"><span className="font-mono text-1">{provider.model}</span></Row> : null}
          <Row k="Spent today">{c ? fmtUsd(c.daySpentUsd) : costs.error ? "Unavailable" : "..."}</Row>
          <Row k="Live total">{c ? fmtUsd(c.liveSpentUsd) : costs.error ? "Unavailable" : "..."}</Row>
          <p className="mt-2 text-1 text-gray-11">
            {state === "offline"
              ? "The API did not answer the last health check. The bar retries every 15 seconds."
              : "Chosen when the API starts (WEFT_LLM). Restart the API to switch models."}
          </p>
        </PopoverContent>
      </Popover>
    </>
  );
}

const STEPS = [
  { key: "1h", label: "+1 hour", body: { by: "PT1H" } },
  { key: "1d", label: "+1 day", body: { by: "P1D" } },
  { key: "next", label: "Next routine", body: { toNext: "cron" } },
] as const;

function ClockSegment() {
  const health = useHealth();
  const clock = useSimClock();
  const now = clock.data?.now ?? health.data?.clock.now;
  const rate = clock.data?.rate ?? health.data?.clock.rate;
  const next = now ? nextRoutineSlot(now) : null;
  const advance = useMutation((body: Record<string, string>) => client.post("/v1/sim/clock/advance", { body }));
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, body: Record<string, string>) => {
    setBusy(key);
    try { await advance.run(body); } finally { setBusy(null); }
  };

  return (
    <Popover>
      <PopoverTrigger
        data-seg=""
        data-testid={TID.simClock}
        data-now={now ?? ""}
        aria-label={clockAria(now)}
        className={cn(segmentClass, "tabular")}
      >
        <Clock aria-hidden strokeWidth={1.5} className="hidden size-4 text-gray-11 @min-[480px]:block" />
        <span className="hidden @min-[760px]:inline">{now ? fmtClock(now) : "..."}</span>
        <span className="@min-[760px]:hidden">{now ? fmtShortClock(now) : "..."}</span>
      </PopoverTrigger>
      <PopoverContent align="center" aria-label="Simulated time" data-testid={W3_SHELL_TID.clockPopover} className="motion-reduce:data-[state=open]:animate-none">
        <div className="font-semibold text-gray-12">Simulated time</div>
        <div className="pt-1 pb-1.5 text-2 font-medium tabular text-gray-12">{now ? fmtLongClock(now) : "..."}</div>
        <Row k="Rate">{rateLabel(rate)}</Row>
        <Row k="Next routine">{next ? fmtShortClock(next) : "None scheduled"}</Row>
        <div className="flex flex-wrap gap-1.5 pt-2">
          {STEPS.map((s) => (
            <Button key={s.key} size="xs" variant="secondary" data-step={s.key} disabled={busy !== null} onClick={() => void run(s.key, s.body)}>
              {busy === s.key ? "Moving..." : s.label}
            </Button>
          ))}
        </div>
        {advance.error ? <p role="alert" className="mt-2 text-1 text-red-11">{errorText(advance.error)}</p> : null}
        <p className="mt-2 text-1 text-gray-11">
          Every date in Weft reads this clock. <Link href="/app/simulators" className="rounded-sm text-gray-12 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]">Open simulators</Link> for the full controls.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Model, then simulated clock, then Viewing as (system, then time, then identity). */
export function EnvPill() {
  return (
    <div role="group" aria-label="Demo environment" data-testid={W3_SHELL_TID.envPill} data-tour="env-pill" className={pillClass}>
      <ModelSegment />
      <span aria-hidden data-divider="" className={dividerClass} />
      <ClockSegment />
      <span aria-hidden data-divider="" className={dividerClass} />
      <PersonaMenu />
    </div>
  );
}
