// One offboarding case (wave 2). Owner: w2-offboarding (docs/wave2.md).
import { OffboardingRoute } from "@/components/app/route-shells";
import { shellStaticParams } from "@/lib/static-export";

export const generateStaticParams = shellStaticParams;

export default async function OffboardingCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OffboardingRoute id={id} />;
}
