import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "@/components/tour/tour.css";
import { TourProvider } from "@/components/tour/tour-provider";
import { HostedRoot } from "@/components/hosted/hosted-root";
import { HOSTED } from "@/lib/hosted/flags";

export const metadata: Metadata = {
  title: "Weft",
  description: "Open-source, self-hostable, AI-native payroll and HR. Synthetic data only.",
};

// Hosted build only: zod builds its object parsers with `new Function` when it may, and probes for that with a caught
// `Function("")` the first time a schema is built. Under the hosted CSP (no 'unsafe-eval') the probe is a reported
// violation, so the head turns zod's JIT off before any app module runs (parsing is unchanged). The export's CSP
// hashes this inline script with the others (apps/web/scripts/cf-export.ts).
const ZOD_JITLESS = "(globalThis.__zod_globalConfig=Object.assign(globalThis.__zod_globalConfig||{},{jitless:true}))";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {HOSTED ? <head><script dangerouslySetInnerHTML={{ __html: ZOD_JITLESS }} /></head> : null}
      <body className="min-h-dvh bg-background text-foreground antialiased"><TourProvider>{children}{HOSTED ? <HostedRoot /> : null}</TourProvider></body>
    </html>
  );
}
