import { PayrollReview } from "@/components/app/payroll/payroll-review";

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PayrollReview id={id} />;
}
