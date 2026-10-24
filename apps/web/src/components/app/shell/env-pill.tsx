"use client";
// The environment pill (D2): simulated clock, then Viewing as, in one white container. Each segment opens
// its own popover or menu (research/wave3/topbar-design.md 5.3 to 5.6).
import Link from "next/link";
import { Clock } from "lucide-react";
import { useState } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, W3_SHELL_TID } from "@weft/contracts";
import { client, errorText, useHealth, useMutation, useSimClock } from "@/lib/api/hooks";
import { fmtClock, fmtShortClock } from "../format";
import { clockAria, fmtLongClock, nextRoutineSlot, rateLabel } from "./env";
import { PersonaMenu } from "./persona-menu";
import { dividerClass, pillClass, segmentClass } from "./segment";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="w-[88px] shrink-0 text-gray-11">{k}</span>
      <span className="min-w-0 flex-1 tabular text-gray-12">{children}</span>
    </div>
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
      <PopoverContent align="center" aria-label="Clock" data-testid={W3_SHELL_TID.clockPopover} className="motion-reduce:data-[state=open]:animate-none">
        <div className="font-semibold text-gray-12">Clock</div>
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

/** The clock, then Viewing as (time, then identity). */
export function EnvPill() {
  return (
    <div role="group" aria-label="Environment" data-testid={W3_SHELL_TID.envPill} data-tour="env-pill" className={pillClass}>
      <ClockSegment />
      <span aria-hidden data-divider="" className={dividerClass} />
      <PersonaMenu />
    </div>
  );
}
