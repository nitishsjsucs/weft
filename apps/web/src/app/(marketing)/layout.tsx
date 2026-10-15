import type { ReactNode } from "react";

// Marketing shell. Owner: t6-site.
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-[1280px] px-4 laptop:px-8">{children}</div>;
}
