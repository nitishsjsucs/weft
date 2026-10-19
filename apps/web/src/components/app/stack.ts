// A table that turns into stacked rows in a narrow column (a phone, or a half-width card): below 40rem of its
// container's width each row becomes a block with its lead cell on the first line and every other cell as a
// "Label value" item after it, so no figure hides past a sideways scroll. One table either way, so screen readers
// and tests read the same cells. The container is the nearest element with the `@container` class (put STACK.box on
// the table's card); each non-lead cell carries data-label with its column's header.
//
// Literal class names only, so Tailwind's scanner sees every one.
export const STACK = {
  /** On the card or wrapper that sets the width the table stacks at. */
  box: "@container",
  /** On the Table. */
  table: "@max-[40rem]:block @max-[40rem]:[&_tbody]:block",
  /** On THead: kept for screen readers, hidden from view while the rows stack. */
  head: "@max-[40rem]:sr-only",
  /** On each body TR. */
  row: "@max-[40rem]:flex @max-[40rem]:flex-wrap @max-[40rem]:items-baseline @max-[40rem]:gap-x-4 @max-[40rem]:gap-y-1 @max-[40rem]:px-3 @max-[40rem]:py-2.5",
  /** On the row's lead cell (the name): a line of its own. */
  lead: "@max-[40rem]:block @max-[40rem]:h-auto @max-[40rem]:basis-full @max-[40rem]:p-0",
  /** On the lead cell when a short second cell (a status, a rate) shares its line: grows, so that cell sits at the end. */
  leadShared: "@max-[40rem]:block @max-[40rem]:h-auto @max-[40rem]:flex-1 @max-[40rem]:p-0",
  /** On every other cell: "Label value", with the label from data-label. */
  cell: "@max-[40rem]:block @max-[40rem]:h-auto @max-[40rem]:p-0 @max-[40rem]:text-left @max-[40rem]:before:mr-1.5 @max-[40rem]:before:text-gray-10 @max-[40rem]:before:content-[attr(data-label)]",
  /** On a cell whose value names itself (a badge, a status): no label before it. */
  bare: "@max-[40rem]:block @max-[40rem]:h-auto @max-[40rem]:p-0 @max-[40rem]:text-left",
} as const;
