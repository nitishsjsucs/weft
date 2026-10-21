export const meta = {
  name: 'weft-cloudflare-build',
  description: 'Build Weft on Cloudflare in eight tracks (round 0, six parallel worktrees, integration), deploy to weft.nitish-ratakonda.workers.dev, verify live and land on main',
  phases: [
    { title: 'Round 0', detail: 'cf0 contracts, schema, compose split, dependencies' },
    { title: 'Tracks', detail: 'cf1 to cf6 in parallel worktrees, each reviewed adversarially and fixed' },
    { title: 'Integrate', detail: 'merge in order, combined suites, local full stack' },
    { title: 'Deploy', detail: 'resources, secrets, deploy, conformance, seed, smoke' },
    { title: 'Verify', detail: 'live walkthrough on the deployed URL and a security check of the public surface' },
    { title: 'Land', detail: 'fix what verify found, redeploy, merge into main' },
  ],
}

const REPO = '/Users/nitishcs/Developer/projects/weft'
const WT = '/Users/nitishcs/Developer/projects/weft-worktrees'
const INTEG = `${WT}/cf-integration`
const CONTEXT = `You are building Weft on Cloudflare. Weft is Nitish's open-source AI-native payroll and HR platform at ${REPO} (TypeScript pnpm 12 monorepo, Node 25.9). The source of truth for this work is ${REPO}/docs/cloudflare/design.md (read section 0 first: it includes the settings Nitish chose on 2026-10-20, which override any other value) and ${REPO}/docs/cloudflare/tracks.md (the rules for every track, the track you own, its owned paths and its acceptance commands). Follow them exactly; where they are silent, choose what keeps the harness invariants exact and the local Node version unchanged.

Hard rules (they repeat tracks.md and add to it):
- Never switch branches or edit files in the main checkout ${REPO} unless your task says so: Nitish's dev server runs there on ports 3070 and 4070 with data in ${REPO}/.data. Never touch those ports, that process or that data. Work in your worktree under ${WT}.
- The integration branch is cf/integration, checked out at ${INTEG}. Track branches are cf/<track id>, each in ${WT}/<track id>.
- Commits: author nitishsjsucs <227862909+nitishsjsucs@users.noreply.github.com> (git -c user.name=nitishsjsucs -c user.email=227862909+nitishsjsucs@users.noreply.github.com commit ...), no Co-Authored-By trailer. Never commit apps/web/next-env.d.ts. No file name contains the word report.
- Fixed-port suites (pnpm e2e on 3170/4170, pnpm e2e:tour and anything else on a fixed port) are shared by all tracks: always run them through the macOS lock, for example: lockf /private/tmp/claude-501/weft-e2e.lock pnpm e2e. Check a port with lsof before starting a server on it. Long commands go to the background with their output in a log file under the worktree's .scratch/.
- Secrets: never print, log, echo, commit or copy a secret value. Parse secrets files with awk, never source them, and pass a value only into one command's environment or stdin. Cloudflare account dc93c3bc8aa4f9e09a0d7e7354a80873; the account token is CF_SETUP_TOKEN in ~/Developer/projects/.people-analytics.secrets.env (trim whitespace); the OpenAI key is OPENAI_API_KEY in ~/Developer/projects/.weft.secrets.env. Only the Integrate, Deploy, Verify and Land stages call the Cloudflare API, through scripts/cf/with-cf.sh.
- Free plan only: never upgrade, add a payment method, create accounts, accept terms or enable account settings. Turnstile: never try to solve, automate or get around a real Turnstile challenge in a browser. Use Turnstile's official test keys in local and Miniflare runs, and only the design's own operator or smoke path on the deployed URL.
- Brand and prose: never name the reference product outside research/; run pnpm lint:prose and pnpm lint:brand before committing. Status words: verified locally, simulated, deployed; never claim production use.
- Spend: automated tests use the scripted provider. Live model calls are allowed only in the Deploy, Verify and Land stages (Nitish opted in to the live demo), inside the hosted caps.`

const STATUS = {
  type: 'object',
  properties: {
    id: { type: 'string' }, branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    done: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
    contract_requests: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'branch', 'commits', 'done', 'tests', 'remaining'],
}
const REVIEW = {
  type: 'object',
  properties: {
    acceptance_passed: { type: 'boolean' },
    verified: { type: 'array', items: { type: 'string' } },
    blocking: { type: 'array', items: { type: 'string' } },
    minor: { type: 'array', items: { type: 'string' } },
  },
  required: ['acceptance_passed', 'verified', 'blocking', 'minor'],
}

phase('Round 0')
const cf0 = await agent(`${CONTEXT}

You own track cf0-contracts. Set up first: in ${REPO} (without switching the main checkout's branch) create branch cf/integration from main and add the worktree ${INTEG} for it (git -C ${REPO} worktree add ${INTEG} -b cf/integration main). In ${INTEG}: pnpm install, then implement the whole cf0-contracts section of docs/cloudflare/tracks.md, run every cf0 acceptance command (pnpm e2e through the lock), and commit on cf/integration. The base digest and every pinned eval digest must be unchanged and the compose split must be a pure move. Return the status with id "cf0".`, { label: 'cf0:contracts', phase: 'Round 0', schema: STATUS })
log(`cf0: ${cf0 ? cf0.commits.length + ' commits; remaining ' + cf0.remaining.length : 'failed'}`)

phase('Tracks')
const TRACKS = [
  { id: 'cf1-db', note: 'Critical path. Every conformance case in design 11.3 must pass on both the node:sqlite emulator and workerd, including the refused linear transaction and the rollback of writes issued after awaits, top level and nested.' },
  { id: 'cf2-platform', note: 'Zero node:fs on the durable path, proven by the fs guard; Node behavior unchanged (pnpm e2e, pnpm e2e:tour and pnpm eval:ci through the lock).' },
  { id: 'cf3-agent', note: 'Spend core and the hosted caps (read from KV config per design section 0), RunHost, the AI Gateway OpenAI transport, the workers_ai provider and the remote MCP handler.' },
  { id: 'cf4-worker', note: 'The front Worker, CompanyDO, LobbyDO, SpendDO, ReseedWorkflow, cron, queues, both wrangler configs, deploy and budget scripts and the Miniflare suite. Do not deploy anything; the Deploy stage does. Pool size 2 and the lease settings from design section 0. Your final acceptance after cf1, cf2 and cf3 merge happens in the Integrate stage, so here run everything that does not need their code, and stub against the cf0 contracts.' },
  { id: 'cf5-web', note: 'The Next static export, id shells, polling discipline, the WebSocket feed and the hosted shell and pages. The local Node app must look and behave exactly as today when not hosted.' },
  { id: 'cf6-extras', note: 'OCR, PDF rendering, AI Search help capped at 30 a day, dictation, the Vectorize recall source (off by default), the D1 run catalog and the MetricsSink (D1, since Analytics Engine stays undeclared). Your final acceptance after cf2 and cf4 merge happens in the Integrate stage.' },
]

const tracks = await pipeline(
  TRACKS,
  t => agent(`${CONTEXT}

You own track ${t.id}. ${t.note}
Set up: git -C ${REPO} worktree add ${WT}/${t.id} -b cf/${t.id} cf/integration (cf0 has landed on cf/integration). In that worktree run pnpm install --frozen-lockfile, then implement the whole ${t.id} section of docs/cloudflare/tracks.md and the parts of design.md it points to. Stay inside your owned paths; anything you need elsewhere goes into .scratch/contract-requests/${t.id}.md for the Integrate stage. Run every acceptance command of your section that can run without the other tracks (fixed-port suites through the lock), make them pass, and commit on cf/${t.id}. Be complete: no TODO stubs on the paths the design requires, and tests for everything you build. Return the status with id "${t.id}" and branch "cf/${t.id}", with exact test counts in tests and any contract requests.`, { label: `build:${t.id}`, phase: 'Tracks', schema: STATUS }),
  (built, t) => built ? agent(`${CONTEXT}

Adversarially review track ${t.id} on branch cf/${t.id} in ${WT}/${t.id}. Do not edit files. Assume it is wrong until you have checked it yourself:
- run its acceptance commands from docs/cloudflare/tracks.md (fixed-port suites through the lock) and check every "must show" item one by one;
- check owned-path discipline: git -C ${WT}/${t.id} diff --name-only cf/integration...cf/${t.id} must touch only the track's owned paths plus .scratch/contract-requests/;
- read the code for the risky parts: transactions and atomicity, invariants (approval executes once, the hash-chained append-only action log, taint, grounding, spend caps), secrets handling, anything that would break the local Node version or the pinned digests, silent catch-and-continue, TODOs on required paths, tests that cannot fail.
The builder reported: ${JSON.stringify(built).slice(0, 6000)}
Blocking means: an acceptance command fails, a must-show item is not met, an invariant can break, a secret can leak, Node behavior changes, or required work is missing.`, { label: `review:${t.id}`, phase: 'Tracks', schema: REVIEW }).then(review => ({ built, review })) : null,
  (r, t) => {
    if (!r) return null
    if (r.review && r.review.blocking.length === 0 && r.review.acceptance_passed) return { ...r.built, review: r.review }
    return agent(`${CONTEXT}

Fix track ${t.id} on branch cf/${t.id} in ${WT}/${t.id}. A reviewer found these blocking problems: ${JSON.stringify(r.review ? r.review.blocking : ['review failed to run']).slice(0, 8000)}
Minor notes (fix the cheap ones): ${JSON.stringify(r.review ? r.review.minor : []).slice(0, 3000)}
Fix every blocking problem at its root, rerun the full acceptance for ${t.id} (fixed-port suites through the lock), and commit. Return the status with id "${t.id}" and branch "cf/${t.id}"; list anything still unresolved in remaining.`, { label: `fix:${t.id}`, phase: 'Tracks', schema: STATUS }).then(fixed => ({ ...fixed, review: r.review }))
  },
)
tracks.forEach((s, i) => log(`${TRACKS[i].id}: ${s ? (s.remaining || []).length + ' remaining' : 'FAILED'}`))

phase('Integrate')
const integ = await agent(`${CONTEXT}

You own the integration part of track cf7-integrate. In ${INTEG} (branch cf/integration) merge the track branches in the order tracks.md gives: cf/cf1-db, cf/cf2-platform, cf/cf3-agent, then cf/cf4-worker, then cf/cf6-extras, then cf/cf5-web. Resolve conflicts keeping both intents. Fold in every .scratch/contract-requests/*.md from the merged branches. Then run the combined acceptance: every track's acceptance commands including the deferred final acceptance of cf4 and cf6 and the deep-link check of cf5, the Node suites (pnpm typecheck, pnpm test, pnpm e2e and pnpm e2e:tour through the lock, pnpm eval:ci, pnpm demo), the durable-emu suites, the Miniflare suite, and the local full stack (wrangler dev on the cf7 port 5800 with Turnstile test keys and the scripted provider) driven by the e2e/cf specs including the guided tour and the eight demo scenarios. Fix whatever fails at the root and commit on cf/integration. Do not deploy. Track results for context: ${JSON.stringify(tracks).slice(0, 20000)}
Return the status with id "integrate" and branch "cf/integration".`, { label: 'integrate', phase: 'Integrate', schema: STATUS })

phase('Deploy')
const deploy = await agent(`${CONTEXT}

You own the deploy part of track cf7-integrate, working in ${INTEG} on cf/integration. Follow design.md section 9 and tracks.md cf7:
1. Read-only billing check first (the account must still be on Workers Free with no Paid subscription); stop and report if not.
2. Create the resources idempotently (pnpm cf:resources through scripts/cf/with-cf.sh): KV weft-config with the section 0 caps and settings, D1 weft-ops, R2 weft-files with its lifecycle rules, Vectorize weft-memory, Queues, AI Gateway weft, the Turnstile widget for weft.nitish-ratakonda.workers.dev, the AI Search instance capped at 30 a day, and anything else the design lists. Never declare Analytics Engine.
3. Install secrets with wrangler secret put reading values from stdin (the OpenAI key from the weft secrets file; generated random values for the session HMAC, the vault key and the smoke/operator secret; the Turnstile secret from the widget). Keep a record of which secrets exist (names only) in docs/cloudflare/deploy.md, and store any generated secret values Nitish may need (for example the operator secret) only in ~/Developer/projects/.weft.secrets.env by appending NAME=value lines with awk or a heredoc that never echoes to the terminal.
4. Deploy weft-core then weft. Run the deployed conformance check on a scratch DO, seed the showcase, the two pool slots and slot-smoke, then run the smoke (scripts/cf/smoke.ts) and the budget readout (CPU p50 and p99 from the GraphQL Analytics API, rows written per slot, neurons, gateway cost).
5. Run one live tour on the smoke or operator path against luna through AI Gateway and record the time, cost and gateway log id.
Write docs/cloudflare/deploy.md with the URL, the resources (names and ids that are not secret), the measured numbers and how to redeploy, and commit on cf/integration. Integration status for context: ${JSON.stringify(integ).slice(0, 8000)}
Return the status with id "deploy", the deployed URL in done, and every failure in remaining.`, { label: 'deploy', phase: 'Deploy', schema: STATUS })

phase('Verify')
const URL_HINT = 'https://weft.nitish-ratakonda.workers.dev'
const [walk, sec] = await parallel([
  () => agent(`${CONTEXT}

Verify the deployed Weft at ${URL_HINT} like a demo audience would, on the live model. Use Playwright (headless Chromium) from ${INTEG} with the design's operator or smoke path to get a lease; never solve or get around a real Turnstile challenge. Then: run the full 20-step guided tour on luna through AI Gateway and time it (budget 180 s); walk the eight demo scenarios in docs/demo-scenarios.md and check each one's key numbers on screen; open every page in the sidebar and check for empty states, errors, broken layout at 1440x900 and 390x844, and console errors; check the Workers AI model switch with one chat question; check a PDF (offer letter or pay stub), receipt OCR on one sample receipt, Help search once, and the remote MCP endpoint with the MCP key (list tools, one read, one proposal that lands in the Inbox). Save screenshots under ${INTEG}/docs/cloudflare/screenshots/ and commit them. Deploy status for context: ${JSON.stringify(deploy).slice(0, 6000)}
Return blocking problems (anything a demo audience would see break) and minor ones.`, { label: 'verify:live', phase: 'Verify', schema: REVIEW }),
  () => agent(`${CONTEXT}

Security-check the deployed public surface at ${URL_HINT} and the deployed configuration, without attacking anything outside it and without load testing beyond a few requests. Check: weft-core has no public route (workers_dev and preview URLs off); client-sent x-weft-proxy, x-weft-ctx and x-weft-smoke headers are stripped and cannot impersonate a session, slot or operator; session cookies are HMAC-signed, HttpOnly, Secure and SameSite; a visitor cannot read or write another slot's data; the showcase world is read-only; model-calling actions require a lease and Turnstile; the caps are enforced server side (try one action over a cap with a small test, not by spending); the MCP endpoint requires its key and MCP input is tainted; no secret appears in any response, static asset, source map, log line or the repo (grep the built assets and the git history of cf/integration); CSP and security headers are present; error responses leak no stack traces or internal ids beyond what the design allows. Deploy status for context: ${JSON.stringify(deploy).slice(0, 6000)}
Return blocking problems (an exploitable issue or a leak) and minor ones.`, { label: 'verify:security', phase: 'Verify', schema: REVIEW }),
])

phase('Land')
const land = await agent(`${CONTEXT}

Land the Cloudflare build. In ${INTEG} on cf/integration:
1. Fix every blocking problem from the two verify reviews below at its root (and the cheap minor ones), rerun the affected suites, redeploy with the same scripts, and recheck each fixed item on the deployed URL.
2. Update the docs owned by cf7: README (a short hosted section with the URL, what runs on Cloudflare and how to deploy), SPEC 9.9, docs/models.md, docs/demo-scenarios.md and docs/cloudflare/deploy.md with measured numbers. Run pnpm lint:prose and pnpm lint:brand. Commit.
3. Merge cf/integration into main in the main checkout ${REPO} with a fast-forward if possible (git -C ${REPO} merge --ff-only cf/integration; if main moved, merge carefully), never committing apps/web/next-env.d.ts, then run pnpm install --frozen-lockfile in ${REPO}. Do not start, stop or restart Nitish's dev server.
4. Remove the cf-* track worktrees (keep the branches) but keep ${INTEG}.
Verify findings: live ${JSON.stringify(walk).slice(0, 10000)} security ${JSON.stringify(sec).slice(0, 10000)}
Return the status with id "land": the URL, what is deployed and verified, and anything still open (with the reason) in remaining.`, { label: 'land', phase: 'Land', schema: STATUS })

return { cf0, tracks, integ, deploy, walk, sec, land }
