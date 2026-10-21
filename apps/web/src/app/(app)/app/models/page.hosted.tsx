// The model comparison page (hosted build only, see platform/page.hosted.tsx). docs/cloudflare/design.md 5.2.
import { ModelsView } from "@/components/hosted/models-view";

export const metadata = { title: "Model comparison | Weft" };

export default function ModelsPage() {
  return <ModelsView />;
}
