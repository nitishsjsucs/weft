"use client";
// The guided tour (owner: tour). Lives in the root layout so it survives the hop from /app to /portal, and renders
// nothing unless a tour is active. engine.ts holds the state machine; this file runs each step: navigate, locate the
// target, ring it, then wait for Next, a click's observed effect, or an agent run (soft and budget-capped hard
// timeouts with fallback copy). It never moves the simulated clock and never approves anything but the one rate
// change the person approves on step 7. Autoplay clicks Approve only for the proposal this session's own notice run
// made (autoApproveAllowed); a deep link or a stale pending card waits for a person.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getPrincipal, invalidate, rawFetch, setPrincipal } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";
import { getBridge } from "./bridge";
import { activate, closeAppLayers, isTypingTarget, reducedMotion, scrollToView, scrollWithRoomAbove, sleep, typeInto, waitForAny } from "./dom";
import { clearNavigation, clearTour, hasSeen, IDLE, loadTour, markNavigation, markSeen, preflightReasons, readPreflight, reduce, resetErrorText, restorePlan, saveTour, takeOwnNavigation } from "./engine";
import {
  autoApproveAllowed, budgetHardMs, budgetSoftMs, fill, lingerMs, stepBody, stepIndex, targetCandidates, TOUR_CHART_PROMPT, TOUR_COPY, TOUR_PRINCIPAL, TOUR_STEPS,
  type TourMemo, type TourStep,
} from "./steps";
import { TourCard, type CardView, type StatusTone } from "./tour-card";
import { TourRing } from "./tour-ring";
import { TourResetDialog } from "./tour-reset-dialog";
import { TOUR_RESET_COPY } from "./steps";

export interface TourApi {
  start: (opts?: { stepId?: string; autoplay?: boolean }) => void;
  openReset: () => void;
  active: boolean;
  seen: boolean;
}
const Ctx = createContext<TourApi>({ start: () => undefined, openReset: () => undefined, active: false, seen: true });
/** Safe outside the provider (unit renders): the no-op API. */
export const useTour = (): TourApi => useContext(Ctx);

const session = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };
const local = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

async function apiGet<T>(path: string): Promise<T> {
  const res = await rawFetch(`/api${path}`, { headers: { accept: "application/json", "x-weft-principal": getPrincipal() } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json ?? { _tag: "Internal", message: res.statusText });
  return json as T;
}
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await rawFetch(`/api${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-weft-principal": getPrincipal() }, body: JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json ?? { _tag: "Internal", message: res.statusText });
  return json as T;
}

type Mode = "next" | "proxy" | "finish" | "back-to-step";
interface Ui {
  stepId: string;
  ready: boolean;
  target: HTMLElement | null;
  found: boolean;
  /** Which selector the target matched: the step's own, or one of its fallbacks (data-target-match, for the specs). */
  match: "primary" | "fallback" | null;
  secondary: Element[];
  /** The step's avoid selectors, filled from the memo: what the card keeps clear of, besides the secondary marks. */
  avoid: string[];
  status: { text: string; tone: StatusTone } | null;
  note: string | null;
  body: string | null;
  nextEnabled: boolean;
  mode: Mode;
  extra: { label: string; onClick: () => void; testid?: string }[];
  link: { href: string; label: string } | null;
  offPage: boolean;
}
const freshUi = (stepId: string): Ui => ({ stepId, ready: false, target: null, found: false, match: null, secondary: [], avoid: [], status: null, note: null, body: null, nextEnabled: false, mode: "next", extra: [], link: null, offPage: false });

const RUN_TERMINAL_BAD = new Set(["failed", "refused", "escalated", "expired", "cancelled"]);

function useMedia(q: string): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

const pathOnly = (href: string) => href.split("#")[0]!.split("?")[0]!;
/** The app shell scrolls inside its own panes; a scrollIntoView can still nudge the document, which clips the top bar. */
const resetDocScroll = () => { try { if (window.location.pathname.startsWith("/app") && (window.scrollY || document.documentElement.scrollTop)) window.scrollTo(0, 0); } catch { /* no window */ } };
const here = () => `${window.location.pathname}${window.location.search}`;

export function TourProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [s, dispatch] = useReducer(reduce, IDLE);
  const sRef = useRef(s);
  sRef.current = s;
  const [ui, setUiState] = useState<Ui>(() => freshUi(TOUR_STEPS[0]!.id));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const setUi = useCallback((patch: Partial<Ui>) => setUiState((u) => ({ ...u, ...patch })), []);
  const [nonce, setNonce] = useState(0);
  const [seen, setSeen] = useState(true);
  const [announce, setAnnounce] = useState("");
  const [closedNote, setClosedNote] = useState(false);
  const [reset, setReset] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const phone = useMedia("(max-width: 767px)");
  const desktopKeys = useMedia("(min-width: 768px)");
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const hover = useRef({ pointer: false, focus: false });
  const expected = useRef<string | null>(null);
  const primaryRef = useRef<(() => void) | null>(null);
  const autoplayRef = useRef(s.autoplay);
  autoplayRef.current = s.autoplay;

  const memo = () => sRef.current.memo;
  const patchMemo = useCallback((patch: Partial<TourMemo>) => {
    sRef.current = { ...sRef.current, memo: { ...sRef.current.memo, ...patch } };
    dispatch({ type: "memo", patch });
  }, []);
  const elapsed = () => Date.now() - (sRef.current.startedAt || Date.now());
  const paused = () => hover.current.pointer || hover.current.focus || (typeof document !== "undefined" && document.hidden);

  // ---- persistence, resume and deep links ---------------------------------------------------------------------
  const booted = useRef(false);
  const handledQuery = useRef<string | null>(null);
  useEffect(() => { if (booted.current) saveTour(session(), s); }, [s]);
  useEffect(() => { setSeen(hasSeen(local())); }, [s.status]);

  const runPreflight = useCallback(async () => {
    const facts = await readPreflight((p) => apiGet(p));
    dispatch({ type: "preflight-done", reasons: preflightReasons(facts) });
  }, []);

  const start = useCallback((opts: { stepId?: string; autoplay?: boolean } = {}) => {
    const b = getBridge();
    const deep = opts.stepId && stepIndex(opts.stepId) > 0;
    dispatch({ type: "start", at: Date.now(), prevPrincipal: getPrincipal(), prevAgentOpen: b ? b.agentOpen() : null, autoplay: opts.autoplay, stepId: opts.stepId });
    if (getPrincipal() !== TOUR_PRINCIPAL) setPrincipal(TOUR_PRINCIPAL);
    setClosedNote(false);
    if (deep) dispatch({ type: "preflight-done", reasons: [] });   // deep links (docs, screenshots, tests) skip the reset offer
    else void runPreflight();
  }, [runPreflight]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tour");
    if (t && handledQuery.current !== window.location.search) {
      handledQuery.current = window.location.search;
      const autoplay = q.get("autoplay") === "1";
      q.delete("tour"); q.delete("autoplay");
      const rest = q.toString();
      router.replace(`${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
      start({ stepId: t === "1" ? undefined : t, autoplay });
    } else if (!booted.current) {
      const p = loadTour(session());
      if (p) dispatch({ type: "resume", persisted: p, auto: takeOwnNavigation(session(), window.location.pathname, Date.now()) });
    }
    booted.current = true;
  }, [pathname, router, start]);

  // ---- exit, finish and reset ---------------------------------------------------------------------------------
  const restore = useCallback(() => {
    const st = sRef.current;
    clearTour(session());
    markSeen(local());
    setSeen(true);
    const plan = restorePlan(st, getPrincipal());
    if (plan.principal) setPrincipal(plan.principal);
    const b = getBridge();
    if (b && plan.agentOpen !== null) b.setAgentOpen(plan.agentOpen);
  }, []);
  const exit = useCallback(() => {
    restore();
    dispatch({ type: "exit" });
    setClosedNote(true);
    setAnnounce(TOUR_COPY.closed);
  }, [restore]);
  const finish = useCallback(() => { restore(); dispatch({ type: "exit" }); setAnnounce("Tour finished"); }, [restore]);
  useEffect(() => { if (!closedNote) return; const t = setTimeout(() => setClosedNote(false), 4000); return () => clearTimeout(t); }, [closedNote]);

  const openReset = useCallback(() => { setReset({ busy: false, error: null }); dispatch({ type: "open-reset", from: "menu" }); }, []);
  const doReset = useCallback(async () => {
    setReset({ busy: true, error: null });
    try {
      await apiPost("/v1/sim/reset", { profile: "rich" });
      invalidate();
      getBridge()?.clearThread();
      setPrincipal(TOUR_PRINCIPAL);
      if (!sRef.current.prevPrincipal) sRef.current = { ...sRef.current, prevPrincipal: TOUR_PRINCIPAL };
      router.push("/app");
      setReset({ busy: false, error: null });
      dispatch({ type: "reset-done", at: Date.now() });
    } catch (e) {
      const text = e instanceof ApiError ? resetErrorText(e.status, e.tag, e.message, TOUR_RESET_COPY.disabled) : resetErrorText(null, null, e instanceof Error ? e.message : String(e), TOUR_RESET_COPY.disabled);
      setReset({ busy: false, error: text });
    }
  }, [router]);

  // ---- the step runner ----------------------------------------------------------------------------------------
  const goNext = useCallback(() => {
    const st = sRef.current;
    if (st.status !== "running") return;
    if (st.stepId === TOUR_STEPS[TOUR_STEPS.length - 1]!.id) finish();
    else dispatch({ type: "next" });
  }, [finish]);

  const resolveHref = useCallback(async (index: number): Promise<string | "skip"> => {
    let i = index;
    while (i > 0 && TOUR_STEPS[i]!.route.kind === "same") i--;
    const r = TOUR_STEPS[i]!.route;
    if (r.kind === "path") return r.path;
    if (r.kind === "draft") {
      if (!memo().draftId) {
        try {
          const runs = await apiGet<{ data: { id: string; status: string; periodStart: string }[] }>("/v1/payrolls?limit=100");
          const draft = runs.data.filter((x) => x.status === "draft").sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1))[0];
          patchMemo({ draftId: draft?.id ?? null });
        } catch { patchMemo({ draftId: null }); }
      }
      return memo().draftId ? `/app/payroll/${memo().draftId}` : "/app/payroll";
    }
    if (r.kind === "portal") {
      if (!memo().personaId) {
        try {
          const offers = await apiGet<{ data: { status: string; personaPrincipalId?: string | null; candidateFirst: string; candidateLast: string }[] }>("/v1/offers?limit=100");
          const rank = (st: string) => (st === "accepted" ? 0 : st === "viewed" ? 1 : st === "sent" ? 2 : 9);
          const o = offers.data.filter((x) => x.personaPrincipalId && rank(x.status) < 9).sort((a, b) => rank(a.status) - rank(b.status))[0];
          patchMemo({ personaId: o?.personaPrincipalId ?? null, hireName: o ? `${o.candidateFirst} ${o.candidateLast}` : null });
        } catch { patchMemo({ personaId: null }); }
      }
      return memo().personaId ? `/portal?as=${encodeURIComponent(memo().personaId!)}` : "skip";
    }
    return "/app";
  }, [patchMemo]);

  /** Per-step lookups of dynamic ids (proposal, action seq) from the API at step entry. */
  const resolveMemo = useCallback(async (step: TourStep) => {
    if (step.id === "inbox-proposal" || (step.id === "approve" && !memo().rateProposalId)) {
      if (memo().approved && memo().rateProposalId) return;
      try {
        const props = await apiGet<{ data: { id: string; command: string | null; proposerRunId: string | null }[] }>("/v1/proposals?status=pending&limit=100");
        const rate = props.data.filter((p) => p.command === "tax.update_rate");
        const mine = memo().noticeRunId ? rate.find((p) => p.proposerRunId === memo().noticeRunId) : undefined;
        // Step 6 may show any pending rate card; only the one this session's notice run made counts as the tour's own.
        const pick = mine ?? (step.id === "inbox-proposal" ? rate[0] : undefined);
        patchMemo({ rateProposalId: pick?.id ?? null, rateProposalOwn: !!mine });
      } catch { /* the step falls back to any pending card */ }
    }
    if (step.id === "audit" && memo().rateProposalId && !memo().rateSeq) {
      try {
        const p = await apiGet<{ executedActionSeq: number | null }>(`/v1/proposals/${encodeURIComponent(memo().rateProposalId!)}`);
        patchMemo({ rateSeq: p.executedActionSeq });
      } catch { /* no secondary mark */ }
    }
  }, [patchMemo]);

  useEffect(() => {
    if (s.status !== "running") return;
    const index = stepIndex(s.stepId);
    const step = TOUR_STEPS[index];
    if (!step) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const enteredAt = Date.now();
    const motion: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
    let described: { el: HTMLElement; prev: string | null } | null = null;
    setUiState(freshUi(step.id));
    resetDocScroll();
    primaryRef.current = null;
    hover.current = { pointer: false, focus: false };

    const ring = (el: HTMLElement | null) => {
      if (!el) return;
      if (described) described.el.setAttribute("aria-describedby", described.prev ?? "");
      described = { el, prev: el.getAttribute("aria-describedby") };
      el.setAttribute("aria-describedby", bodyId);
    };
    const statusLine = (text: string, tone: StatusTone, say?: string) => { setUi({ status: { text, tone } }); if (say) setAnnounce(say); };
    /** Autoplay for next-like steps: advance once the step's seconds have passed (minus time already spent). */
    const autoplayAfter = async (ms: number, then: () => void) => {
      let due = Date.now() + ms;
      while (!signal.aborted) {
        await sleep(200, signal);
        if (signal.aborted) return;
        if (!autoplayRef.current || paused()) { due += 200; continue; }
        if (Date.now() >= due) { then(); return; }
      }
    };
    /** Moves on only while this step is still the current one (a sleep cut short by Back must not advance). */
    const advance = () => { if (!signal.aborted) goNext(); };
    const dwell = () => Math.max(0, step.seconds * 1000 - (Date.now() - enteredAt));

    void (async () => {
      // 1. Route.
      const href = await resolveHref(index);
      if (signal.aborted) return;
      if (href === "skip") { advance(); return; }
      if (pathOnly(href) !== window.location.pathname || (href.includes("?") && here() !== href.split("#")[0])) {
        if (window.location.pathname.startsWith("/portal") && !href.startsWith("/portal")) setPrincipal(TOUR_PRINCIPAL);
        markNavigation(session(), pathOnly(href), Date.now());
        router.push(href);
      } else if (href.includes("#") && window.location.hash !== `#${href.split("#")[1]}`) {
        window.location.hash = href.split("#")[1]!;
      }
      expected.current = pathOnly(href);
      const until = Date.now() + 15_000;
      while (!signal.aborted && window.location.pathname !== expected.current && Date.now() < until) await sleep(50, signal);
      if (signal.aborted) return;
      clearNavigation(session());

      // 2. Shell: the agent panel for agent steps, the nav drawer below 1024 px.
      const b = getBridge();
      if (step.agent) b?.setAgentOpen(true);
      else if (b && !b.desktop()) b.setAgentOpen(false);
      if (step.nav && b && !b.laptop()) b.openNav();

      // 3. Dynamic ids, then the controls the step clicks first (a tab, a flag, a row).
      await resolveMemo(step);
      if (signal.aborted) return;
      for (const list of step.prepare ?? []) {
        const hit = await waitForAny(list.map((x) => fill(x, memo())).filter((x): x is string => !!x), 5_000, signal);
        if (signal.aborted) return;
        if (hit) { hit.el.scrollIntoView({ block: "center", behavior: "auto" }); activate(hit.el); await sleep(300, signal); }
      }

      // 4. Locate the target (5 s), then ring it.
      const cands = targetCandidates(step, memo());
      const hit = step.target ? await waitForAny(cands, 5_000, signal) : null;
      if (signal.aborted) return;
      if (hit) {
        // Card height (about 220 px) plus its gap and padding, so it fits between the pane's top and the ring.
        if (step.cardAbove) scrollWithRoomAbove(hit.el, 268, motion);
        else scrollToView(hit.el, step.block ?? "center", motion);
        ring(hit.el);
        // A column the copy names, inside a table that scrolls sideways on a phone (the rate's notice source).
        const inner = step.reveal ? hit.el.querySelector<HTMLElement>(step.reveal) : null;
        if (inner) window.setTimeout(() => inner.scrollIntoView({ block: "nearest", inline: "nearest", behavior: motion }), 350);
        window.setTimeout(resetDocScroll, 450);
      }
      const secondary: Element[] = [];
      for (const sel of step.secondary ?? []) {
        const f = fill(sel, memo());
        if (!f) continue;
        try { const el = document.querySelector(f); if (el && el !== hit?.el) secondary.push(el); } catch { /* bad selector */ }
      }
      const avoid = (step.avoid ?? []).map((sel) => fill(sel, memo())).filter((x): x is string => !!x);
      const missing = !!step.target && !hit;
      const body = step.id === "rate-live" && !memo().approved ? TOUR_COPY.rateNotApproved : null;
      setUi({ ready: true, target: hit?.el ?? null, found: !!hit || step.target === null, match: hit ? (hit.selector === cands[0] ? "primary" : "fallback") : null, secondary, avoid, note: missing ? TOUR_COPY.missing : null, body, nextEnabled: true, mode: step.action === "finish" ? "finish" : "next" });
      setAnnounce(`Step ${index + 1} of ${TOUR_STEPS.length}: ${step.title}`);
      // The card focuses its title (tour-card.tsx), except on steps that open an app popover or drawer: moving focus
      // out of the flag popover would close it (Radix dismisses on focus outside); the live region still announces.

      // 5. The step's action.
      if (step.action === "finish") {
        setUi({
          extra: [
            { label: "Replay", onClick: () => { dispatch({ type: "replay", at: Date.now() }); void runPreflight(); } },
            { label: "Reset demo data", onClick: openReset },
          ],
        });
        primaryRef.current = finish;
        void autoplayAfter(dwell(), finish);
        return;
      }
      primaryRef.current = advance;

      if (step.id === "audit" && memo().rateSeq && !memo().undoneSeq) {
        const seq = memo().rateSeq!;
        const undoEl = document.querySelector<HTMLElement>(`[data-tour~="audit-undo"][data-seq="${seq}"]`);
        if (undoEl) {
          setUi({
            extra: [{
              label: "Try Undo", onClick: () => {
                activate(undoEl);
                patchMemo({ undoneSeq: seq });
                setUi({ extra: [] });
                void waitForAny([`[data-tour~="audit-row"][data-reverses="${seq}"]`], 8_000, signal).then((row) => {
                  if (!row || signal.aborted) return;
                  scrollToView(row.el, "center", motion);
                  ring(row.el);
                  setUi({ target: row.el, found: true, secondary: [], avoid: [] });
                });
              },
            }],
          });
        }
      }

      if (step.action === "next" || missing && step.action !== "wait-run") {
        if (missing && step.action !== "next") setUi({ mode: "next", nextEnabled: true });
        void autoplayAfter(dwell(), advance);
        return;
      }

      if (step.action === "click") {
        const once = step.id === "deliver-notice" ? memo().delivered : memo().approved;
        if (once) {
          setUi({ note: step.id === "deliver-notice" ? TOUR_COPY.alreadyDelivered : TOUR_COPY.alreadyDecided, mode: "next", nextEnabled: true });
          void autoplayAfter(dwell(), advance);
          return;
        }
        const el = hit!.el;
        let clickedAt = 0;
        el.addEventListener("click", () => { if (!clickedAt) { clickedAt = Date.now(); statusLine(TOUR_COPY.agentWorking, "working"); } }, { capture: true, signal });
        const proxy = () => { if (!clickedAt) activate(el); };
        // Autoplay approves only the proposal this session's own notice run made; anything else waits for a person.
        const autoOk = step.id !== "approve" || autoApproveAllowed(memo());
        let waitNoted = false;
        primaryRef.current = proxy;
        setUi({ mode: "proxy", nextEnabled: false });
        const hard = budgetHardMs(index, elapsed());
        const before = new Set(getBridge()?.runIds() ?? []);
        const readyAt = Date.now();
        let lastPoll = 0;
        while (!signal.aborted) {
          await sleep(150, signal);
          if (signal.aborted) return;
          if (!clickedAt && autoplayRef.current && !paused() && Date.now() - readyAt >= 1500) {
            if (autoOk) proxy();
            else if (!waitNoted) { waitNoted = true; setUi({ note: TOUR_COPY.approveYourself }); }
          }
          if (step.id === "deliver-notice") {
            const fresh = (getBridge()?.runIds() ?? []).find((id) => !before.has(id));
            if (fresh) { patchMemo({ noticeRunId: fresh, delivered: true }); advance(); return; }
            if (clickedAt && Date.now() - clickedAt > hard) { patchMemo({ delivered: true, noticeRunId: null }); advance(); return; }
          } else if (Date.now() - lastPoll > (clickedAt ? 400 : 1000)) {
            lastPoll = Date.now();
            const pid = memo().rateProposalId;
            const errEl = el.closest('[data-tour~="inbox-card"]')?.querySelector('[role="alert"]:not([data-testid="inbox-tainted-banner"])');
            try {
              const p = await apiGet<{ status: string; executedActionSeq: number | null }>(`/v1/proposals/${encodeURIComponent(pid ?? "")}`);
              if (p.status === "executed") {
                patchMemo({ approved: true, rateSeq: p.executedActionSeq });
                statusLine(TOUR_COPY.agentDone, "done", "Approved and executed");
                await sleep(600, signal);
                advance();
                return;
              }
              if (p.status !== "pending" && p.status !== "approved") {
                setUi({ note: errEl?.textContent?.trim() || `The approval did not go through: ${p.status}.`, status: null, mode: "next", nextEnabled: true });
                patchMemo({ approveError: p.status });
                void autoplayAfter(2_000, advance);
                return;
              }
            } catch { /* keep polling until the hard timeout */ }
            if (!clickedAt) continue;
            if (errEl?.textContent?.trim()) {
              setUi({ note: errEl.textContent.trim(), status: null, mode: "next", nextEnabled: true });
              void autoplayAfter(2_000, advance);
              return;
            }
            if (Date.now() - clickedAt > hard) {
              setUi({ note: "The approval is taking longer than usual. Nothing else changes, so carry on.", status: null, mode: "next", nextEnabled: true });
              void autoplayAfter(0, advance);
              return;
            }
          }
        }
        return;
      }

      if (step.action === "wait-run") {
        const runId = memo().noticeRunId;
        if (!runId) {
          setUi({ note: TOUR_COPY.noticeStopped, nextEnabled: true });
          void autoplayAfter(dwell(), advance);
          return;
        }
        setUi({ nextEnabled: false });
        statusLine(TOUR_COPY.agentWorking, "working");
        const soft = budgetSoftMs(index, elapsed());
        const hard = budgetHardMs(index, elapsed());
        const t0 = Date.now();
        let apiStatus: string | null = null;
        let lastApi = 0;
        let softShown = false;
        while (!signal.aborted) {
          await sleep(200, signal);
          if (signal.aborted) return;
          const dom = document.querySelector<HTMLElement>(`[data-tour~="agent-run"][data-run-id="${runId}"]`)?.dataset.status ?? null;
          if (Date.now() - lastApi > 1000) {
            lastApi = Date.now();
            void apiGet<{ status: string }>(`/v1/agent/runs/${encodeURIComponent(runId)}`).then((r) => { apiStatus = r.status; }, () => undefined);
          }
          const st = dom && dom !== "starting" && dom !== "queued" && dom !== "running" ? dom : apiStatus;
          if (st === "waiting" || st === "held" || st === "done") {
            if (st === "done") statusLine(TOUR_COPY.agentDone, "done", "The agent finished");
            else statusLine(TOUR_COPY.agentWaiting, "waiting", "The agent finished and is waiting for your approval");
            // The finished run stays on screen: a reader moves on with Next, autoplay after the step's own seconds.
            const first = document.querySelector<HTMLElement>(`[data-tour~="agent-run"][data-run-id="${runId}"] [data-tour~="agent-tool-lines"]`);
            if (first) first.scrollIntoView({ block: phone ? "start" : "center", behavior: motion });
            setUi({ nextEnabled: true, mode: "next" });
            primaryRef.current = advance;
            void autoplayAfter(lingerMs(index, elapsed(), dwell(), 4_000), advance);
            return;
          }
          if (st && RUN_TERMINAL_BAD.has(st)) {
            setUi({ note: TOUR_COPY.noticeStopped, status: { text: st, tone: "error" }, nextEnabled: true });
            setAnnounce(TOUR_COPY.noticeStopped);
            void autoplayAfter(2_000, advance);
            return;
          }
          const waited = Date.now() - t0;
          if (!softShown && waited >= soft) { softShown = true; statusLine(TOUR_COPY.stillWorking, "working"); setUi({ nextEnabled: true }); }
          if (waited >= hard) {
            setUi({ note: TOUR_COPY.noticeSlow, status: { text: TOUR_COPY.stillWorking, tone: "muted" }, nextEnabled: true });
            setAnnounce(TOUR_COPY.noticeSlow);
            void autoplayAfter(0, advance);
            return;
          }
        }
        return;
      }

      if (step.action === "ask") {
        const prev = memo().chartRunId;
        if (prev) {
          const chart = document.querySelector<HTMLElement>(`[data-run-id="${prev}"] [data-tour~="agent-chart"]`);
          if (chart) { chart.scrollIntoView({ block: "center", behavior: motion }); ring(chart); setUi({ target: chart }); }
          setUi({ mode: "next", nextEnabled: true });
          void autoplayAfter(dwell(), advance);
          return;
        }
        const box = hit!.el;
        const field = (box.matches("textarea") ? box : box.querySelector("textarea")) as HTMLTextAreaElement | null;
        const before = new Set(getBridge()?.runIds() ?? []);
        if (field) await typeInto(field, TOUR_CHART_PROMPT, signal);
        if (signal.aborted) return;
        let sentAt = 0;
        // One send per step: once Send is clicked the composer empties, and a later tick must not type or send again.
        let clickedAt = 0;
        let typing = false;
        const send = () => {
          if (sentAt || typing) return;
          if (clickedAt) {
            // A click that never reached the agent leaves the prompt in the composer; only then try once more.
            if (Date.now() - clickedAt < 4_000 || !field || field.value.trim() !== TOUR_CHART_PROMPT) return;
          }
          const btn = document.querySelector<HTMLElement>('[data-tour~="agent-send"]');
          if (field && !field.value.trim()) {
            if (clickedAt) return;
            typing = true;
            void typeInto(field, TOUR_CHART_PROMPT, signal).finally(() => { typing = false; });
            return;
          }
          if (btn) { clickedAt = Date.now(); activate(btn); }
        };
        primaryRef.current = send;
        setUi({ mode: "proxy", nextEnabled: false });
        const readyAt = Date.now();
        let soft = budgetSoftMs(index, elapsed());
        let hard = budgetHardMs(index, elapsed());
        let runId: string | null = null;
        let softShown = false;
        while (!signal.aborted) {
          await sleep(150, signal);
          if (signal.aborted) return;
          if (!sentAt && autoplayRef.current && !paused() && Date.now() - readyAt >= 1500) send();
          if (!runId) {
            const fresh = (getBridge()?.runIds() ?? []).find((id) => !before.has(id));
            if (fresh) {
              runId = fresh;
              sentAt = Date.now();
              soft = budgetSoftMs(index, elapsed());
              hard = budgetHardMs(index, elapsed());
              patchMemo({ chartRunId: fresh, asked: true });
              setUi({ mode: "next", nextEnabled: false });
              primaryRef.current = advance;
              statusLine(TOUR_COPY.agentWorking, "working");
            }
            continue;
          }
          const chart = document.querySelector<HTMLElement>(`[data-run-id="${runId}"] [data-tour~="agent-chart"]`);
          if (chart) {
            chart.scrollIntoView({ block: "center", behavior: motion });
            ring(chart);
            setUi({ target: chart, found: true, nextEnabled: true, mode: "next" });
            statusLine(TOUR_COPY.agentDone, "done", "The chart is ready");
            primaryRef.current = advance;
            void autoplayAfter(lingerMs(index, elapsed(), dwell(), 5_000), advance);
            return;
          }
          const status = document.querySelector<HTMLElement>(`[data-tour~="agent-run"][data-run-id="${runId}"]`)?.dataset.status;
          const waited = Date.now() - sentAt;
          if (!softShown && waited >= soft) { softShown = true; statusLine(TOUR_COPY.stillWorking, "working"); setUi({ nextEnabled: true }); }
          if (waited >= hard || (status && RUN_TERMINAL_BAD.has(status)) || (status === "done" && waited > 2500)) {
            setUi({ note: TOUR_COPY.chartSlow, link: { href: "/app/reports", label: "Open Reports" }, status: null, nextEnabled: true });
            setAnnounce(TOUR_COPY.chartSlow);
            void autoplayAfter(0, advance);
            return;
          }
        }
      }
    })();

    return () => {
      ctrl.abort();
      if (described) { if (described.prev) described.el.setAttribute("aria-describedby", described.prev); else described.el.removeAttribute("aria-describedby"); }
      if (step.dock === "side") {
        // Close the popover or drawer the step opened, so it never lingers into the next step (or over the agent sheet).
        // A trigger still open after the outside press is toggled on the next task: clicking it inside React's commit
        // phase would make Radix flush synchronously.
        closeAppLayers();
        window.setTimeout(() => document.querySelectorAll<HTMLElement>('[data-tour~="payroll-flag"][aria-expanded="true"]').forEach((el) => activate(el)), 0);
      }
      resetDocScroll();
      if (step.nav) { const b = getBridge(); if (b && !b.laptop()) b.closeNav(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status, s.stepId, nonce]);

  // Leaving the step's page by hand shows "You left the tour's page" with Back to step and Exit.
  useEffect(() => {
    if (s.status !== "running" || !uiRef.current.ready || !expected.current) return;
    if (pathname !== expected.current) setUi({ offPage: true });
  }, [pathname, s.status, setUi]);

  // ---- keyboard -----------------------------------------------------------------------------------------------
  useEffect(() => {
    if (s.status !== "running") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement as HTMLElement | null;
      if (isTypingTarget(ae)) return;
      const onBody = !ae || ae === document.body;
      const inCard = !!ae?.closest("[data-tour-card]");
      const onControl = !!ae && !onBody && /^(BUTTON|A|SUMMARY)$/.test(ae.tagName);
      const u = uiRef.current;
      if (e.key === "Escape") { e.preventDefault(); exit(); return; }
      if (!u.ready) return;
      if (e.key === "ArrowRight" && u.nextEnabled) { e.preventDefault(); if (u.offPage) setNonce((n) => n + 1); else if (u.mode === "finish") finish(); else if (u.mode !== "proxy") goNext(); else primaryRef.current?.(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); dispatch({ type: "back" }); return; }
      if (onControl) return;   // Enter and Space on a button belong to that button
      if (e.key === "Enter" && (inCard || onBody)) { e.preventDefault(); if (u.offPage) setNonce((n) => n + 1); else if (u.mode === "finish") finish(); else if (u.nextEnabled || u.mode === "proxy") primaryRef.current?.(); return; }
      if (e.key === " " && (inCard || onBody)) { e.preventDefault(); dispatch({ type: "autoplay", on: !sRef.current.autoplay }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.status, exit, finish, goNext]);

  // ---- render -------------------------------------------------------------------------------------------------
  const api = useMemo<TourApi>(() => ({ start, openReset, active: s.status !== "idle", seen }), [start, openReset, s.status, seen]);
  const index = Math.max(0, stepIndex(s.stepId));
  const step = TOUR_STEPS[index]!;
  const lowerHalf = (() => { try { const r = ui.target?.getBoundingClientRect(); return !!r && r.top + r.height / 2 > window.innerHeight / 2; } catch { return false; } })();
  const sheet: CardView["sheet"] = phone && step.target !== null ? (step.sheet ?? (step.agent || lowerHalf ? "top" : "bottom")) : null;
  const primaryLabel = ui.offPage ? "Back to step" : ui.mode === "finish" ? "Finish" : ui.mode === "proxy" ? (step.proxyLabel ?? "Next") : "Next";
  const view: CardView = {
    step, index, ready: ui.ready && ui.stepId === step.id, found: ui.found && !ui.offPage, match: ui.offPage ? null : ui.match, target: ui.offPage ? null : ui.target,
    body: ui.offPage ? "Go back to where the tour was, or exit." : ui.body ?? stepBody(step, s.memo),
    status: ui.offPage ? null : ui.status, note: ui.offPage ? null : ui.note,
    nextEnabled: ui.offPage || ui.nextEnabled || ui.mode !== "next",
    primary: {
      label: primaryLabel, kbd: primaryLabel === "Next",
      onClick: () => { if (ui.offPage) setNonce((n) => n + 1); else if (ui.mode === "finish") finish(); else primaryRef.current?.(); },
    },
    secondary: ui.offPage ? [] : ui.extra, link: ui.offPage ? null : ui.link, offPage: ui.offPage, sheet, avoid: ui.avoid, marks: ui.secondary,
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {s.status === "running" ? (
        <>
          {ui.ready && !ui.offPage && step.target !== null ? <TourRing target={ui.target} found={ui.found} secondary={ui.secondary} /> : null}
          <TourCard
            v={view}
            h={{ onBack: () => dispatch({ type: "back" }), onExit: exit, onToggleAutoplay: () => dispatch({ type: "autoplay", on: !s.autoplay }), onHover: (kind, v) => { hover.current = { ...hover.current, [kind]: v }; }, titleRef, bodyId, titleId, autoplay: s.autoplay, desktop: desktopKeys, focusTitle: step.dock !== "side" }}
          />
        </>
      ) : null}
      {s.status === "resume" ? (
        <div data-tour-resume="" role="dialog" aria-modal="false" aria-label="Resume tour" className="weft-tour-card fixed bottom-6 left-1/2 z-[70] flex w-[min(360px,calc(100vw-24px))] -translate-x-1/2 items-center gap-2 rounded-xl bg-card p-3 text-[13px] shadow-[var(--shadow-modal)]">
          <span className="flex-1 text-gray-11">Resume tour (step {index + 1} of {TOUR_STEPS.length})</span>
          <button type="button" className="h-7 rounded-lg px-2.5 text-gray-11 hover:bg-gray-a3" onClick={exit}>Exit</button>
          <button type="button" data-tour-resume-go="" className="h-7 rounded-lg bg-gray-12 px-2.5 font-medium text-white" onClick={() => dispatch({ type: "resume-accept" })}>Resume</button>
        </div>
      ) : null}
      <TourResetDialog
        open={s.status === "reset"} from={s.resetFrom} reasons={s.resetReasons} busy={reset.busy} error={reset.error}
        onReset={() => void doReset()}
        onSkip={() => { setReset({ busy: false, error: null }); dispatch({ type: "reset-skip", at: Date.now() }); }}
        onCancel={() => { setReset({ busy: false, error: null }); dispatch({ type: "reset-cancel" }); }}
      />
      {closedNote ? <div data-tour-closed="" role="status" className="fixed bottom-6 left-1/2 z-[70] w-[min(360px,calc(100vw-24px))] -translate-x-1/2 rounded-xl bg-card px-4 py-3 text-[13px] text-gray-11 shadow-[var(--shadow-modal)]">{TOUR_COPY.closed}</div> : null}
      <div className="sr-only" aria-live="polite" data-tour-live="">{s.status === "running" || closedNote ? announce : ""}</div>
    </Ctx.Provider>
  );
}
