// Shared classes for the top bar (research/wave3/topbar-design.md 5.3 and 5.5). Owner: w3-topbar-shell.

/**
 * A segment of the environment pill: 28 px tall at radius 6 inside the pill's 2 px pad, 13 px label, gray-a3 on hover,
 * gray-a4 while its popover or menu is open, and an inset 2 px blue-9 ring on keyboard focus so it never collides
 * with its neighbors.
 */
export const segmentClass =
  "weft-press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] leading-5 font-medium whitespace-nowrap text-gray-12 outline-none " +
  "hover:bg-[var(--tb-fill-hover)] data-[state=open]:bg-[var(--tb-fill-open)] focus-visible:shadow-[inset_0_0_0_2px_var(--blue-9)] [&_svg]:shrink-0";

/** The 1 x 16 divider between segments; hidden next to a hovered or open segment (see pillClass). */
export const dividerClass = "mx-0.5 h-4 w-px shrink-0 bg-[var(--tb-divider)] transition-opacity";

/** The pill: one white container with a hairline ring, 32 px tall with a 2 px pad. */
export const pillClass =
  "inline-flex h-8 shrink-0 items-center rounded-lg bg-[var(--tb-surface)] p-0.5 shadow-[var(--tb-edge)] " +
  "[&>[data-seg]:hover+[data-divider]]:opacity-0 [&>[data-divider]:has(+[data-seg]:hover)]:opacity-0 " +
  "[&>[data-seg][data-state=open]+[data-divider]]:opacity-0 [&>[data-divider]:has(+[data-seg][data-state=open])]:opacity-0";

/** Every icon button in the bar: ghost, 32 x 32 at radius 8, 16 px icon, pressed shows the hover fill. */
export const barIconClass = "text-gray-11 aria-pressed:bg-[var(--tb-fill-hover)] aria-pressed:text-foreground";
