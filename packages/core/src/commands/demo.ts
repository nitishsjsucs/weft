// demo.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
// Human-only demo controls that drive the simulators: sim.deliver_notice.
import type { WeftCommand } from "../shared/deps";
import { deliverNotice } from "../notices/deliver";

export const demoCommands: WeftCommand[] = [deliverNotice];
