// Listen-address checks for scripts/phoenix.ts (pure, so tests can import them without running a command).

/** The listen addresses in `lsof -nP -iTCP:<port> -sTCP:LISTEN` output ("127.0.0.1:6207", "*:6207", "[::1]:6207"). */
export function listenAddresses(lsofOut: string): string[] {
  return lsofOut.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 9)
    .map((c) => (c[c.length - 1] === "(LISTEN)" ? c[c.length - 2]! : c[c.length - 1]!));
}
/** True for 127.x.x.x, [::1] and localhost binds; false for "*", "[::]", "0.0.0.0" or a LAN address. */
export const isLoopbackAddress = (a: string): boolean => /^(127\.\d+\.\d+\.\d+|\[::1\]|localhost):\d+$/.test(a);
