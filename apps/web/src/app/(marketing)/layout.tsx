import type { ReactNode } from "react";

// Marketing shell (full width; sections set their own 1280 px container). Owner: t6-site.
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh overflow-x-clip bg-background">{children}</div>;
}
