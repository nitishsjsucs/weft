"use client";
// Small client islands for the landing page. Owner: t6-site.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { loomGlyphs, MADDER } from "./art";

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** The company's simulated clock, ticking at the API's clock rate (0 means frozen, as in E2E). */
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

/**
 * The hero's loom field on a canvas: the same seeded glyphs as public/brand/loom-glyphs.svg, with the '|' threads
 * drifting slowly downward (wrapping at the bottom) and the madder glyphs pulsing where the agent is "working". Pauses offscreen and when the
 * tab is hidden; draws one static frame under prefers-reduced-motion.
 */
export function LoomCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const field = loomGlyphs({ cols: 80, rows: 30 });
    const cw = 16, rh = 22;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, visible = true, last = 0;
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (t: number) => {
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      ctx.font = "13px 'JetBrains Mono Variable', ui-monospace, monospace";
      ctx.textAlign = "center";
      const offsetX = width - field.cols * cw;   // right-aligned, like xMaxYMin
      const span = field.rows * rh;
      for (const g of field.glyphs) {
        const x = offsetX + g.x * cw + cw / 2;
        if (x < -cw) continue;
        const y = (g.y * rh + 16 + (g.ch === "|" ? t / 90 : 0)) % span;   // threads drift down and wrap
        if (g.accent) {
          ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t / 700 + g.x);
          ctx.fillStyle = MADDER;
        } else {
          ctx.globalAlpha = g.o * 0.7;
          ctx.fillStyle = "#bbbbbb";
        }
        if (y > height + rh) continue;
        ctx.fillText(g.ch, x, y);
      }
      ctx.globalAlpha = 1;
    };
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || t - last < 50) return;   // about 20 frames a second is plenty
      last = t;
      draw(t);
    };
    size();
    draw(0);
    const ro = new ResizeObserver(() => { size(); draw(last); });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; });
    io.observe(canvas);
    if (!reduce) raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, []);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
