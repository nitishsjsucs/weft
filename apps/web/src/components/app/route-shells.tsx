"use client";
// Client halves of the five `[id]` pages. Each resolves the record id with useRouteId (the static export's shell
// passes `_`) and renders the same views the pages rendered before; on Node the id passes straight through.
import { useRouteId, SHELL_ID } from "@/lib/route-id";
import { OffboardingCaseView } from "./offboarding/offboarding-view";
import { PayrollReview } from "./payroll/payroll-review";
import { PersonView } from "./people/people-view";
import { RoutineDetail } from "./routines/routines-view";
import { RunView } from "./runs/run-view";
import { PayrollCrumb, WorkerCrumb } from "./shell/crumbs";

export function PersonRoute({ id }: { id: string }) {
  const rid = useRouteId("people", id);
  if (rid === SHELL_ID) return null;
  return <><WorkerCrumb id={rid} /><PersonView id={rid} /></>;
}

export function PayrollRoute({ id }: { id: string }) {
  const rid = useRouteId("payroll", id);
  if (rid === SHELL_ID) return null;
  return <><PayrollCrumb id={rid} /><PayrollReview id={rid} /></>;
}

export function RunRoute({ id }: { id: string }) {
  const rid = useRouteId("runs", id);
  if (rid === SHELL_ID) return null;
  return <RunView id={rid} />;
}

export function RoutineRoute({ id }: { id: string }) {
  const rid = useRouteId("routines", id);
  if (rid === SHELL_ID) return null;
  return <RoutineDetail id={rid} />;
}

export function OffboardingRoute({ id }: { id: string }) {
  const rid = useRouteId("offboarding", id);
  if (rid === SHELL_ID) return null;
  return <OffboardingCaseView id={rid} />;
}
