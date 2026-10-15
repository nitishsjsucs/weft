// comms.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
// comms.post_update (run feed) is t3-governance's.
import type { WeftCommand } from "../shared/deps";
import { sendMessage } from "../comms/send";

export const commsCommands: WeftCommand[] = [sendMessage];
