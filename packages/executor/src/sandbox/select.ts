// WEFT_SANDBOX picks the code.run engine (harness 3.2). off is the default, so code.run refuses unless it is turned
// on; quickjs is the only engine built (microvm and worker_loader keep the SandboxEngine contract for later).
import type { SandboxEngine } from "@weft/contracts";
import { createQuickJsEngine } from "./quickjs";

export type SandboxMode = "off" | "quickjs" | "unbuilt";

export function sandboxMode(env: Record<string, string | undefined>): { mode: SandboxMode; raw: string } {
  const raw = (env.WEFT_SANDBOX ?? "").trim().toLowerCase() || "off";
  if (raw === "off") return { mode: "off", raw };
  if (raw === "quickjs" || raw === "on") return { mode: "quickjs", raw };
  return { mode: "unbuilt", raw };
}

/** The engine for this environment, or the reason there is none. */
export function sandboxFromEnv(env: Record<string, string | undefined>): { engine: SandboxEngine } | { engine: null; reason: string } {
  const { mode, raw } = sandboxMode(env);
  if (mode === "quickjs") return { engine: createQuickJsEngine() };
  if (mode === "off") return { engine: null, reason: "code.run is off (WEFT_SANDBOX=off); set WEFT_SANDBOX=quickjs to turn it on" };
  return { engine: null, reason: `WEFT_SANDBOX=${raw} is not built; the only engine is quickjs` };
}
