import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "@/components/tour/tour.css";
import { TourProvider } from "@/components/tour/tour-provider";

export const metadata: Metadata = {
  title: "Weft",
  description: "Open-source, self-hostable, AI-native payroll and HR. Synthetic data only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-background text-foreground antialiased"><TourProvider>{children}</TourProvider></body>
    </html>
  );
}
