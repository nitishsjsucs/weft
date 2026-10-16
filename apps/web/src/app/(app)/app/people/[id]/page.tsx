import { PersonView } from "@/components/app/people/people-view";
import { WorkerCrumb } from "@/components/app/shell/crumbs";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <><WorkerCrumb id={id} /><PersonView id={id} /></>;
}
