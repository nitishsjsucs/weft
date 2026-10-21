// The hosted build's 404 page (a page file only when NEXT_PUBLIC_WEFT_HOSTED=1 adds the "hosted.tsx" extension, so
// Node keeps Next's default 404). Workers static assets serve it for any path with no asset (`not_found_handling`).
import Link from "next/link";
import { NotFoundRedirect } from "@/components/hosted/not-found-redirect";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <NotFoundRedirect />
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <h1 className="text-6 font-semibold text-gray-12">Page not found</h1>
        <p className="text-2 text-gray-11">This page is not part of the Weft demo.</p>
        <Link href="/app" className="rounded-sm text-2 text-gray-12 underline underline-offset-2">Open the demo company</Link>
      </div>
    </main>
  );
}
