import type { ReactNode } from "react";
import { AppShell } from "@/components/app/shell/app-shell";

// Logged-in app shell (t5-app): grid 244px 1fr 340px, 48 px header (research/design.md 10 and 13.3).
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
