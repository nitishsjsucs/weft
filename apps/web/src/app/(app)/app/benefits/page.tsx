import { DomainGate } from "@/components/app/domain-gate";
import { BenefitsView } from "@/components/app/products/products-view";

export default function BenefitsPage() {
  return (
    <DomainGate domain="benefits" title="Benefits" subtitle="Benefits elections, premiums and open enrollment are not shared with your role. The People team can answer questions about benefits." testid="benefits-no-access">
      <BenefitsView />
    </DomainGate>
  );
}
