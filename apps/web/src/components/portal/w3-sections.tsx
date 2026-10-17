// Scaffold (frozen): wave 3 portal sections below the new-hire checklist (docs/wave3.md). Each track fills its own file.
import { ExpensesPortalSection } from "./expenses/section";
import { TimeOffPortalSection } from "./time-off/section";
import { ScreeningPortalSection } from "./screening/section";
import { PortalW4People } from "./w4-people";   // wave 4 (w4-parity-people): life events, check-in form
import { W4TrainingSection } from "./w4-training";   // wave 4 (w4-parity-compliance): the person's own required training

export function PortalW3Sections({ workerId, principal }: { workerId: string; principal: string }) {
  return (
    <>
      <ScreeningPortalSection workerId={workerId} principal={principal} />
      <TimeOffPortalSection workerId={workerId} principal={principal} />
      <ExpensesPortalSection workerId={workerId} principal={principal} />
      <PortalW4People workerId={workerId} principal={principal} />
      <W4TrainingSection />
    </>
  );
}
