// @weft/cf-extras (track cf6-extras; docs/cloudflare/design.md 5.4, 6.3, 7.1 and 10): the visitor-facing Cloudflare
// extras, all off the harness path and each behind a KV flag. Receipt and notice OCR, PDF rendering, semantic recall
// candidates, Help search, dictation, the run catalog, the metrics sink and the Platform readout, over structural
// binding types. Nothing here imports @weft/* runtime code (design 3.2): the queue consumers and HostedExtras in
// weft-core load this package without evaluating the Weft modules, and @cloudflare/puppeteer loads only to render.
export * from "./bindings";
export * from "./bytes";
export * from "./catalog";
export * from "./counters";
export * from "./dictation";
export * from "./errors";
export * from "./flags";
export * from "./gateway";
export * from "./help";
export * from "./jobs";
export * from "./metrics";
export * from "./neurons";
export * from "./ocr";
export * from "./pdf";
export * from "./platform";
export * from "./recall";
export * from "./templates";
export * from "./wav";
export * from "../../contracts/src/ext/cf-extras";
