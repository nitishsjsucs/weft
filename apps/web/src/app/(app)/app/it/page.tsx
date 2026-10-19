import { DomainGate } from "@/components/app/domain-gate";
import { ItView } from "@/components/app/products/products-view";

export default function ItPage() {
  return (
    <DomainGate domain="it" title="IT" subtitle="Accounts and devices are not shared with your role. The People team can answer questions about accounts and laptops." testid="it-no-access">
      <ItView />
    </DomainGate>
  );
}
