import { PayrollGate } from "@/components/app/payroll/payroll-gate";
import { PayrollReview } from "@/components/app/payroll/payroll-review";
import { PayrollCrumb } from "@/components/app/shell/crumbs";

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PayrollGate><PayrollCrumb id={id} /><PayrollReview id={id} /></PayrollGate>;
}
