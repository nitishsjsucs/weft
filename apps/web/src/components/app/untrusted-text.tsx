// Text that came from outside Weft or that people typed (a candidate a vendor sent, a background-check item, a chat
// message someone posted), marked for the cursor assistant: its screen map reads [data-assist-untrusted] apart from
// the app's own words and never sends it as a plain label (components/assist/dom.ts).
import type { ReactNode } from "react";

export function Untrusted({ children, className }: { children: ReactNode; className?: string }) {
  return <span data-assist-untrusted="" className={className}>{children}</span>;
}

/** A candidate's name as an offer holds it (typed in Weft, or imported from Greenhouse). */
export function CandidateName({ first, last }: { first: string; last: string }) {
  return <Untrusted>{first} {last}</Untrusted>;
}
