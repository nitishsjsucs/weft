import { PayrollGate } from "@/components/app/payroll/payroll-gate";
import { PayrollList } from "@/components/app/payroll/payroll-list";

export default function PayrollPage() {
  return <PayrollGate><PayrollList /></PayrollGate>;
}
