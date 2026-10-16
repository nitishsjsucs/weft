import { PayrollReview } from "@/components/app/payroll/payroll-review";
import { PayrollCrumb } from "@/components/app/shell/crumbs";

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <><PayrollCrumb id={id} /><PayrollReview id={id} /></>;
}
