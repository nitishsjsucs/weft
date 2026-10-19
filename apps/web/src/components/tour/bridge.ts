// The seam between the tour (root layout) and the app shell (inside /app). The shell registers its agent panel and
// nav drawer controls here, so the tour provider never calls useAgent from above the AgentProvider. Owner: tour.

export interface ShellBridge {
  agentOpen(): boolean;
  setAgentOpen(open: boolean): void;
  clearThread(): void;
  /** Run ids in the agent thread, oldest first. */
  runIds(): string[];
  openNav(): void;
  closeNav(): void;
  /** Sidebar visible (64rem and up). */
  laptop(): boolean;
  /** Agent panel docks (80rem and up). */
  desktop(): boolean;
}

let current: ShellBridge | null = null;
const subs = new Set<() => void>();

export function registerBridge(b: ShellBridge): () => void {
  current = b;
  subs.forEach((f) => f());
  return () => { if (current === b) { current = null; subs.forEach((f) => f()); } };
}

export function getBridge(): ShellBridge | null { return current; }

export function onBridge(f: () => void): () => void { subs.add(f); return () => subs.delete(f); }
