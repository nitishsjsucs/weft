// The DocumentRenderer (design 6.4, 7.1 and 8.2): Weft's own HTML templates rendered to PDF in Browser Run and cached
// in R2 `weft-files` under a key that carries the world, its generation and the HTML's sha256 (or the snapshot for
// the shared seed world). The page is loaded with `page.setContent`, JavaScript is off, and every request the page
// tries is intercepted and aborted, so Browser Run cannot be used to reach any URL (no SSRF). Browser time is a
// daily counter in the Lobby, 300 s a day for Weft, and a cached PDF never starts a browser. Track cf6-extras.
import { BROWSER_SECONDS_PER_DAY, pdfObjectKey, type DocumentRenderer, type PdfKey, type RenderInput, type RenderResult } from "../../contracts/src/ext/cf-extras";
import type { BrowserLauncher, R2BucketLike } from "./bindings";
import { sha256Hex } from "./bytes";
import { COUNTERS, type DailyCounters } from "./counters";
import { ExtrasError } from "./errors";

/** Job bodies stay under the 128 KB queue message limit with room for the other fields. */
export const MAX_PDF_HTML_BYTES = 100_000;

export interface RendererDeps {
  files: R2BucketLike;
  launch: BrowserLauncher;
  counters: DailyCounters;
  /** The `extras.pdf` kill flag; a cached PDF is still served when it is off. */
  enabled: () => boolean | Promise<boolean>;
  browserMsPerDay?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Called for each request the page attempted (each one was aborted). */
  onBlocked?: (url: string) => void;
}

export interface RenderedPdf extends RenderResult { blockedRequests: number }

export function createDocumentRenderer(deps: RendererDeps): DocumentRenderer & { render(input: RenderInput): Promise<RenderedPdf> } {
  const cap = deps.browserMsPerDay ?? BROWSER_SECONDS_PER_DAY * 1000;
  const timeout = deps.timeoutMs ?? 15_000;
  const now = deps.now ?? Date.now;
  return {
    async render(input) {
      const objectKey = pdfObjectKey(input.key);
      const head = await deps.files.head(objectKey);
      if (head) return { objectKey, bytes: head.size, cached: true, browserMs: 0, blockedRequests: 0 };
      if (!(await deps.enabled())) throw new ExtrasError("PDF_DISABLED", "PDF rendering is switched off");
      if (new TextEncoder().encode(input.html).length > MAX_PDF_HTML_BYTES) throw new ExtrasError("PDF_TOO_LARGE", "the document is too large to render");
      // The cache key is the content's hash, so a job can never store one document's PDF under another's key.
      if ((await sha256Hex(input.html)) !== input.key.sha256) throw new ExtrasError("PDF_KEY_MISMATCH", "the PDF key does not match the HTML");
      const used = await deps.counters.peek(COUNTERS.browserMs);
      if (used >= cap) throw new ExtrasError("PDF_BUDGET", "Today's PDF rendering time is used up; try again after 00:00 UTC");
      let blocked = 0;
      const t0 = now();
      let pdf: Uint8Array;
      const browser = await deps.launch();
      try {
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          blocked++;
          deps.onBlocked?.(req.url());
          req.abort("blockedbyclient").catch(() => undefined);
        });
        await page.setContent(input.html, { waitUntil: "load", timeout });
        pdf = await page.pdf({ format: "letter", printBackground: true, timeout });
        await page.close().catch(() => undefined);
      } catch (e) {
        throw new ExtrasError("PDF_RENDER_FAILED", `rendering failed: ${e instanceof Error ? e.message : String(e)}`, true);
      } finally {
        await browser.close().catch(() => undefined);
        await deps.counters.add(COUNTERS.browserMs, Math.max(1, now() - t0));
      }
      const browserMs = Math.max(1, now() - t0);
      if (pdf.length < 5 || String.fromCharCode(...pdf.subarray(0, 5)) !== "%PDF-") throw new ExtrasError("PDF_RENDER_FAILED", "the browser did not return a PDF", true);
      await deps.files.put(objectKey, pdf, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { kind: input.kind, sha256: input.key.sha256, blocked: String(blocked) } });
      return { objectKey, bytes: pdf.length, cached: false, browserMs, blockedRequests: blocked };
    },
  };
}

/** A rendered PDF's bytes from R2, or null when it is not rendered yet. */
export async function cachedPdf(files: R2BucketLike, key: PdfKey): Promise<Uint8Array | null> {
  const obj = await files.get(pdfObjectKey(key));
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

/** The production launcher: `@cloudflare/puppeteer` is imported only when a PDF is actually rendered. */
export function puppeteerLauncher(binding: unknown): BrowserLauncher {
  return async () => {
    const mod = (await import("@cloudflare/puppeteer")) as unknown as { default: { launch(b: unknown): Promise<unknown> } };
    return (await mod.default.launch(binding)) as Awaited<ReturnType<BrowserLauncher>>;
  };
}
