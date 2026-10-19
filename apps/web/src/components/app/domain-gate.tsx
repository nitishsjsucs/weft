"use client";
// A page for people whose grants close its domain (a manager has payroll, benefits and IT: none): the API refuses
// every read behind the page for them (403 NOT_PERMITTED), so the page says so plainly instead of showing an error,
// an empty table or controls that would be refused (Run review now, Submit, Pay contractors). Until the first read of
// the grants comes back (a page opened by URL) it renders an empty body, so no refused read flashes an error.
import type { ReactNode } from "react";
import { canWith, useGrantState } from "@/lib/api/access";
import { PageBody, PageHeader } from "./page";

export type GatedDomain = "payroll" | "benefits" | "it";

export function DomainGate({ domain, title, subtitle, testid, children }: { domain: GatedDomain; title: string; subtitle: string; testid: string; children: ReactNode }) {
  const { grants, loading } = useGrantState();
  if (loading) return <PageBody width="narrow"><div aria-busy="true" /></PageBody>;
  if (canWith(grants, domain)) return <>{children}</>;
  return (
    <PageBody width="narrow">
      <div data-testid={testid}>
        <PageHeader title={title} subtitle={subtitle} />
      </div>
    </PageBody>
  );
}
