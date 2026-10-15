"use client";
// Small client islands for the landing page. Owner: t6-site.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** The demo company's simulated clock, ticking at the API's clock rate (0 means frozen, as in E2E). */
export function SimClockTicker({ now, rate }: { now: string; rate: number }) {
  const [t, setT] = useState(() => Date.parse(now));
  useEffect(() => {
    const start = Date.now(), base = Date.parse(now);
    setT(base);
    if (!rate) return;
    const id = setInterval(() => setT(base + (Date.now() - start) * rate), 1000);
    return () => clearInterval(id);
  }, [now, rate]);
  const parts = FMT.formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return (
    <span className="tabular-nums" data-testid="marketing-sim-clock" suppressHydrationWarning>
      {get("weekday")} {get("month")} {get("day")}, {get("hour")}:{get("minute")}:{get("second")} PT
    </span>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex h-11 min-w-0 items-center gap-2 rounded-[9px] bg-gray-3 pr-1.5 pl-4 font-mono text-2 text-gray-12">
      <span className="text-gray-9" aria-hidden>$</span>
      <code className="min-w-0 flex-1 truncate">{command}</code>
      <button
        type="button"
        className="weft-press inline-flex size-8 shrink-0 items-center justify-center rounded-[7px] text-gray-11 hover:bg-gray-4 hover:text-gray-12"
        aria-label={copied ? "Copied" : `Copy ${command}`}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
        }}
      >
        {copied ? <Check className="size-4" strokeWidth={1.5} /> : <Copy className="size-4" strokeWidth={1.5} />}
      </button>
    </div>
  );
}
