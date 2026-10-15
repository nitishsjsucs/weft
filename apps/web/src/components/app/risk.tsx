import { Badge } from "@weft/ui/components";
import type { RiskClass } from "@weft/contracts";

const TONE: Record<RiskClass, "gray" | "blue" | "amber" | "red"> = { R0: "gray", R1: "gray", R2: "blue", R3: "amber", R4: "red" };
const LABEL: Record<RiskClass, string> = { R0: "read", R1: "draft", R2: "internal write", R3: "money or records", R4: "external or irreversible" };

export function RiskChip({ risk }: { risk: RiskClass | null }) {
  if (!risk) return null;
  return <Badge tone={TONE[risk]} size="sm" data-risk={risk} title={`Risk class ${risk}: ${LABEL[risk]}`}>{risk} <span className="font-normal opacity-80">{LABEL[risk]}</span></Badge>;
}
