import type { ReactNode } from "react";

// App shell placeholder. Owner: t5-app (grid 244px 1fr 340px, 48 px header; research/design.md sections 10 and 13.3).
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 laptop:grid-cols-[244px_1fr]">
      <aside className="hidden border-r border-[var(--app-border)] bg-[var(--app-sidebar-bg)] laptop:block" aria-label="Sidebar" />
      <div className="flex flex-col">
        <header className="h-12 border-b border-[var(--app-border)]" />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
