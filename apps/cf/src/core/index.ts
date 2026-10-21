// weft-core (design 3.1 and 9.4): workers_dev false and preview_urls false, so it has no public route. It exports
// the Durable Objects (CompanyDO, LobbyDO, SpendDO), ReseedWorkflow, the HostedExtras entrypoint the front reaches
// over its CORE service binding, and the cron and queue handlers. CompanyDO loads the real Weft engine lazily: the
// dynamic import below is bundled as a lazily evaluated module, so the top level evaluates only class shells.
import { setEngineLoader } from "./company/engine";
import { coreHandler } from "./exports";

setEngineLoader(() => import("./company/weft-engine").then((m) => m.weftEngineModule));

export { CompanyDO, LobbyDO, SpendDO, ReseedWorkflow } from "./exports";
// HostedExtras: the fallback (Platform readout from the Lobby and SpendDO, every extra off) until cf6-extras' entrypoint
// in src/extras replaces this export.
export { ExtrasFallback as HostedExtras } from "./exports";
export default coreHandler;
