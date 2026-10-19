// The app shell's main pane (the scrolling content column between the sidebar and the agent panel). In-page popovers
// use it as their collision boundary so they never spill over the sidebar or the docked panel, and the tour places
// its card inside it.
export const APP_MAIN_ATTR = "data-app-main";

/** The main pane element, or null outside the app shell (the portal, the site) and during server rendering. */
export function appMain(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[${APP_MAIN_ATTR}]`);
}
