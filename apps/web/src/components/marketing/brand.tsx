// Weft brand pieces as JSX, drawn from the same geometry as the static files in public/brand. Owner: t6-site.
import { HATCH_ID, weaveMarkStrokes, wovenBands } from "./art";

export function WeaveMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#202020" />
      <g fill="none" strokeLinecap="butt">
        {weaveMarkStrokes().map((s, i) => <path key={i} d={s.d} stroke={s.stroke} strokeWidth={s.width} />)}
      </g>
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <WeaveMark size={24} />
      <span className="text-[21px] font-semibold leading-none tracking-[-0.04em] text-gray-12">weft</span>
    </span>
  );
}

/** Three interlaced bands for the CTA band; bleeds off the right edge of its container. */
export function WovenBands({ className, idPrefix = "cta" }: { className?: string; idPrefix?: string }) {
  const w = wovenBands();
  const hatch = `${idPrefix}-${HATCH_ID}`;
  const draw = (x: { band: { color: string; hatch: boolean }; d: string }) => (
    <>
      <path d={x.d} stroke={w.ground} strokeWidth={w.bandWidth + 10} />
      <path d={x.d} stroke={x.band.color} strokeWidth={w.bandWidth} />
      {x.band.hatch ? <path d={x.d} stroke={`url(#${hatch})`} strokeWidth={w.bandWidth} /> : null}
    </>
  );
  return (
    <svg viewBox={`0 0 ${w.width} ${w.height}`} className={className} preserveAspectRatio="xMinYMid slice" aria-hidden="true">
      <defs>
        <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 1H5" stroke="#ffffff" strokeOpacity=".34" strokeWidth="1" /></pattern>
        {w.overs.map((o, k) => (
          <g key={k}>
            <clipPath id={`${idPrefix}-c${k}`}><circle cx={o.cx} cy={o.cy} r={o.r} /></clipPath>
            <mask id={`${idPrefix}-m${k}`} maskUnits="userSpaceOnUse" x="0" y="0" width={w.width} height={w.height}>
              <path d={o.under} fill="none" stroke="#fff" strokeWidth={w.bandWidth + 14} />
            </mask>
          </g>
        ))}
      </defs>
      <g fill="none" strokeLinecap="butt">
        {w.bands.map((b) => <g key={b.band.id}>{draw(b)}</g>)}
        {w.overs.map((o, k) => <g key={k} clipPath={`url(#${idPrefix}-c${k})`}><g mask={`url(#${idPrefix}-m${k})`}>{draw(o)}</g></g>)}
      </g>
    </svg>
  );
}
