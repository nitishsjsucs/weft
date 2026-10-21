// The Platform page (hosted build only: page.hosted.tsx is a page only when NEXT_PUBLIC_WEFT_HOSTED=1 adds the
// "hosted.tsx" page extension in next.config.ts). docs/cloudflare/design.md 10.
import { PlatformView } from "@/components/hosted/platform-view";

export const metadata = { title: "Platform | Weft" };

export default function PlatformPage() {
  return <PlatformView />;
}
