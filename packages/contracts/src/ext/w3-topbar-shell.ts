// w3-topbar-shell additive contract (docs/wave3.md rule 2). Nothing here changes a frozen contract. Owner:
// w3-topbar-shell.

/** DOM ids the top bar's toggles point at (aria-controls); e2e specs read them too. */
export const W3_TOPBAR_SHELL_DOM = { sidebar: "weft-sidebar", agentPanel: "weft-agent-panel" } as const;

/** The header's container-width tiers (research/wave3/topbar-design.md 5.7): Full from 760 px, Compact from 480 px. */
export const W3_TOPBAR_SHELL_TIERS = { fullMin: 760, compactMin: 480 } as const;
