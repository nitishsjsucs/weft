// w2-offboarding additive contract (docs/wave2.md rule 2). Folded into sim.ts at the wave 2 merge: IdpSim.clearGroups
// and DeviceSim.lock are now part of the frozen simulator interfaces. These aliases stay for existing imports.
import type { DeviceSim, IdpSim } from "../sim";

/** IdpSim gains clearGroups (fault target idp.clearGroups); suspend now checks the fault target idp.suspend. */
export interface W2OffboardingIdpSim extends IdpSim { clearGroups(ref: string): Promise<{ removed: string[] }> }

/** DeviceSim gains a remote lock (fault target devices.lock). The lock reference and time are the receipt. */
export interface W2OffboardingDeviceSim extends DeviceSim { lock(req: { workerId: string; deviceId: string; reason: string }): Promise<{ lockRef: string; lockedAt: string }> }
