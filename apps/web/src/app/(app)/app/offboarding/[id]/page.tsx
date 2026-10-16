// One offboarding case (wave 2). Owner: w2-offboarding (docs/wave2.md).
import { OffboardingCaseView } from "@/components/app/offboarding/offboarding-view";

export default async function OffboardingCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OffboardingCaseView id={id} />;
}
