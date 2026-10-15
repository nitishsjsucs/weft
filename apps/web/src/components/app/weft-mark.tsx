/** Original Weft mark: a 2 x 2 over-under weave (two vertical and two horizontal bars interlaced). */
export function WeftMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="currentColor">
      <rect x="3" y="1" width="3" height="14" rx="1" />
      <rect x="10" y="1" width="3" height="14" rx="1" />
      <rect x="1" y="3.5" width="14" height="3" rx="1" opacity=".55" />
      <rect x="1" y="9.5" width="14" height="3" rx="1" opacity=".55" />
      <rect x="3" y="3.5" width="3" height="3" />
      <rect x="10" y="9.5" width="3" height="3" />
    </svg>
  );
}
