import { PayrollGate } from "@/components/app/payroll/payroll-gate";
import { PayrollRoute } from "@/components/app/route-shells";
import { shellStaticParams } from "@/lib/static-export";

export const generateStaticParams = shellStaticParams;

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PayrollGate><PayrollRoute id={id} /></PayrollGate>;
}
