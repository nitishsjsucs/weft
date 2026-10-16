// Scaffold (frozen): wave 3 portal sections below the new-hire checklist (docs/wave3.md). Each track fills its own file.
import { ExpensesPortalSection } from "./expenses/section";
import { TimeOffPortalSection } from "./time-off/section";
import { ScreeningPortalSection } from "./screening/section";

export function PortalW3Sections({ workerId, principal }: { workerId: string; principal: string }) {
  return (
    <>
      <ScreeningPortalSection workerId={workerId} principal={principal} />
      <TimeOffPortalSection workerId={workerId} principal={principal} />
      <ExpensesPortalSection workerId={workerId} principal={principal} />
    </>
  );
}
