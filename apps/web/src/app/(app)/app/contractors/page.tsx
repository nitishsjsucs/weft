import { DomainGate } from "@/components/app/domain-gate";
import { ContractorsView } from "@/components/app/products/products-view";

export default function ContractorsPage() {
  return (
    <DomainGate domain="payroll" title="Contractors" subtitle="Contractor pay and payouts are not shared with your role. A payroll admin can answer questions about contractor pay." testid="contractors-no-access">
      <ContractorsView />
    </DomainGate>
  );
}
