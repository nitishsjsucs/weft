# Sandboxes for the Weft agent workspace

Researched 2026-10-15, 13:47 to 14:05 PDT, on Nitish's Apple M5 (macOS 26.5.2, arm64, Node 25.9.0). Scope: what Weft's agent should run model-written code in, locally today and on a free Cloudflare deployment later, with the brain and hands split kept intact.

Evidence labels used throughout:

- **[OBS]** observed directly on this Mac in a test install (commands and numbers below are mine; scratch folder `/private/tmp/claude-501/-Users-nitishcs-Downloads-resume-fine-tuner/dbbbe8b6-3969-4418-a6af-c3e18c3900aa/scratchpad/`, nothing left running, no files in the repo).
- **[DOC]** stated by the vendor or project (docs, README, pricing page).
- **[3P]** third-party reporting or inference (press, blog teardowns).
- **[INF]** my inference from the sources; verify before relying on it.

## 0. Decision summary (read this if nothing else)

1. **Local build, default sandbox: QuickJS compiled to WebAssembly (`quickjs-emscripten`, MIT), in process, async variant.** Model-written JavaScript runs with no `fetch`, no `require`, no `process`, no filesystem, a 32 MB heap cap and a CPU deadline; its only door out is one host function `weft.call(command, args)` that becomes `Executor.exec` with the run's agent principal. Verified on this Mac: module load 20 to 29 ms, runtime plus context 7 ms, infinite loop interrupted, async host calls work (section 3.1). Same engine runs inside a Cloudflare Worker or Durable Object, so the hosted tier reuses the code path.
2. **Local build, optional heavy tier (off by default): microsandbox microVMs (Apache-2.0, `npm i microsandbox`, no daemon, libkrun on Hypervisor.framework).** For Python, real PDF or XLSX libraries, or a git CLI over a read-only copy of the memory repo. Verified: Linux 6.12 guest, warm boot plus command 1.5 to 1.8 s, `--no-net` blocks DNS and egress, `--mount-dir` works (section 3.2).
3. **Wrap every subprocess the harness itself spawns (git for the memory repo, report renderers) with Anthropic's `sandbox-runtime` (`srt`, Apache-2.0).** Verified: denied read of a fake vault folder and `~/Developer`, denied write to `$HOME`, network denied, write allowed only in the workspace; about 0.6 s overhead per invocation (section 3.3).
4. **Hosted later on Cloudflare Workers FREE: the per-company agent home is one SQLite-backed Durable Object (Free plan supports SQLite DOs only), the sandbox is the same QuickJS-WASM engine inside that DO, persistence is DO SQLite plus R2 for memory-repo bundles and generated files.** Everything Cloudflare markets for running model code (Sandbox SDK, Containers, Dynamic Workers / Worker Loader, therefore Code Mode in production) is **Workers Paid only** [DOC] (section 1).
5. **Avoid:** isolated-vm (fails to build on Node 25.9, maintenance mode), Docker plus gVisor on this Mac (gVisor is Linux only, Docker daemon not running and heavy), Firecracker, nsjail and bubblewrap (Linux only), self-hosted E2B (a whole Linux control plane for one demo), Daytona OSS (repo archived June 2026, AGPL-3.0), Pyodide as the default Python path (7 to 8 s load every time, 190 MB RSS).
6. **What stays outside every sandbox:** the brain (model provider calls), the executor (tiers, grants, approvals, money ceilings), the vault and all keys, the domain database, the hash-chained action log, the memory writer (validated commits), simulators, routines scheduler and MCP server. **What goes inside:** model-written analysis code, a read-only snapshot of the company memory repo, scratch data and report assembly whose output returns as data that the executor turns into a stored file (section 5).

## 1. Cloudflare options vs the Workers FREE plan

Nitish's account is on Workers Free and he does not want Workers Paid. Verdicts below come from developers.cloudflare.com pages fetched today.

| Option | Free plan? | Free limits (if any) | Local dev story | Isolation | Cold start | How Weft would use it |
|---|---|---|---|---|---|---|
| **Sandbox SDK** (`@cloudflare/sandbox` 1.0.1, Apache-2.0 on npm) | **No.** Sandboxes landing page: "Available on Workers Paid plan" [DOC S1]. Built on Containers, whose pricing exists only under Paid [DOC S2] | n/a | `npm run dev`; "First run builds the Docker container (2-3 minutes)"; Docker must be running for `wrangler deploy` [DOC S3]; Containers local dev needs "a Docker compatible CLI tool and Engine" (Docker Desktop or Colima) [DOC S4] | "Each sandbox runs in its own VM" [DOC S5]; Containers page: each instance is a microVM with its own kernel and network [DOC S1] | Not stated in docs fetched. Doc says after first deploy "wait several minutes" for image provisioning [DOC S3] | Only if Nitish ever goes Paid: Python analysis, file generation with native libs. Not for Free |
| **Containers** | **No.** "Available on Workers Paid plan" [DOC S6]. Pricing: included usage "as part of the $5 USD per month Workers Paid plan"; Free column N/A [DOC S2] | Paid includes 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk per month; instance types from `lite` (1/16 vCPU, 256 MiB, 2 GB) to `standard-4` (4 vCPU, 12 GiB, 20 GB) [DOC S2] | `wrangler dev` or `vite dev` with local Docker; `max_instances` ignored locally; container code does not hot-reload [DOC S4] | microVM per instance [DOC S1]; disk and memory "end with the instance"; `snapshotContainer()` in public beta, snapshots expire after 30 days [DOC S7] | Not stated | Same as above |
| **Dynamic Workers / Worker Loader API** | **No.** "Dynamic Workers are currently only available on the Workers Paid plan." [DOC S8] | Paid: 1,000 unique Dynamic Workers per day included then $0.002 each; 10M requests then $0.30/M; 30M CPU ms then $0.02/M [DOC S8]. At most 4 distinct Dynamic Workers in flight per Worker request, 10 per Durable Object [DOC S9] | **Works locally on any plan** [OBS]: wrangler 4.151.0 with a `worker_loaders` binding ran model-written code with `globalOutbound: null` (its `fetch` threw "This worker is not permitted to access the internet via global functions like fetch()") and called a host `WorkerEntrypoint` over RPC via `ctx.exports`; 45 ms for the first request, 19 ms for the next, each a fresh isolate id (section 3.4) | V8 isolate per Dynamic Worker; network blocked by `globalOutbound: null` [DOC S10] [OBS] | Isolates start in "a handful of milliseconds" with "a few megabytes of memory" [DOC S11 blog]; 19 to 45 ms end to end through wrangler dev [OBS] | The best-shaped API for Weft's sandbox (capability bindings, no ambient network) but production needs Paid. Keep as an upgrade path; do not depend on it |
| **Code Mode** (`@cloudflare/codemode` 0.5.4, MIT) | **No in production** [INF]: Code Mode executes in the Worker Loader, which is Paid only [DOC S8]. Local use is fine [DOC S11] | n/a | Blog (2025-09-26): Worker Loader "fully available now for development with Wrangler and workerd"; production was closed beta then [DOC S11]; now Paid GA per pricing page [DOC S8] | Generated code has no `fetch()`/`connect()`; reaches MCP servers only through bindings; "API keys" stay with the supervisor [DOC S11] | Same as Dynamic Workers | **Copy the pattern, not the dependency**: expose Weft's command registry to the model as a typed TS API and let it write code against it, run that code in QuickJS. Cloudflare's claim: "LLMs are better at writing code to call MCP, than at calling MCP directly" [DOC S11] |
| **Durable Objects with SQLite** | **Yes.** On Free "Only Durable Objects with SQLite storage backend are available" [DOC S12] | Per day: 100,000 requests, 13,000 GB-s duration, 5M rows read, 100,000 rows written; 5 GB stored total; ops fail when exceeded [DOC S12]. 100 DO classes per account on Free; CPU per request 30 s default (configurable to 5 min) with no Free/Paid split shown; per-object storage 10 GB in the table but FAQ says 1 GB on Free (the page conflicts with itself) [DOC S13] | Miniflare/workerd emulate DOs in `wrangler dev` [DOC, general wrangler docs; not separately verified today] | Strong between companies: each DO is its own object with private SQLite; code inside one DO is one isolate | DO wake-up, not measured | **The per-company agent home on Free**: one DO per company owns the agent run store, proposals, inbox, action log and alarms for routines. 100,000 rows written per day is the binding constraint for a demo; fine for one fictional company |
| **Durable Object Facets** | Not stated on the page [DOC S14]; it requires the Worker Loader to load the facet class, so Paid in practice [INF] | n/a | n/a | Facet code "cannot read the supervisor's database"; each facet gets its own SQLite [DOC S14] | n/a | Nice future shape (agent-written code gets its own scratch DB, the supervisor keeps the real data) but Paid. Skip |
| **Browser Rendering** | **Yes**, limited [DOC S15] | Free: "10 minutes per day" of browser time, 3 concurrent browsers; Paid: 10 hours per month then $0.09 per hour, 10 concurrent [DOC S15] | Not verified today | Separate headless Chrome; not a code sandbox | Not stated | Weft has no real websites (every agency, bank and carrier is a simulator), so no need. Possible later use: render pay stub or report HTML to PDF, within 10 minutes per day |
| **R2** | Free tier exists; whether it needs a payment method on file is not stated on the pricing page [DOC S16]. **[UNVERIFIED]** I believe R2 activation asks for a payment method even for free usage; Nitish should check the dashboard before relying on it | 10 GB-month storage, 1M Class A, 10M Class B per month, egress free; free tier is Standard storage only [DOC S16] | Miniflare emulates R2 locally (wrangler dev lists `/r2/buckets` in its local explorer [OBS]) | Object storage, not compute | n/a | Store the memory repo as a git bundle per company (Instinct's S3 pattern [3P S30]) and generated files (CSV, PDF). If R2 needs a card, fall back to DO SQLite blobs (5 GB total on Free) |
| **Agents SDK** (`agents` 0.28.1, MIT; repo cloudflare/agents) | No plan statement on the docs landing page [DOC S17]; the base `Agent` runs on Durable Objects, so it inherits DO Free availability [INF]. Its "sandboxed code execution" and Code Mode tools need the Worker Loader or Sandbox SDK, so Paid [INF] | Inherits DO and Workers Free limits | Starter: `npx create-cloudflare@latest --template cloudflare/agents-starter` [DOC S17] | As DOs | n/a | Optional: use the `Agent` class for state, WebSockets and scheduling of routines in the hosted build. Weft's own harness (executor, approvals) stays Weft's; do not adopt the SDK's tool runtime |
| **Workers Free baseline** | Yes | 100,000 requests per day, **10 ms CPU per HTTP request**, 128 MB memory per isolate, 50 subrequests per invocation, 100 Workers per account [DOC S18] | n/a | n/a | n/a | The front Worker must stay thin (auth, routing to the company DO). Long agent turns and QuickJS runs belong in the DO (30 s CPU per request [DOC S13]) [INF]; the 50-subrequest cap limits how many model calls one request may make, so one agent step per request or per alarm [INF] |

Sandbox SDK limits page adds: subrequests per request 50 on Free, 1,000 on Paid [DOC S19]; this does not make the SDK usable on Free, since Containers remain Paid.

**Net for the hosted tier:** on Free, Cloudflare gives Weft durable per-company state (DO SQLite), scheduling (DO alarms), object storage (R2, check the card question) and small amounts of headless Chrome. It gives **no** managed code sandbox. The sandbox has to be something Weft ships inside its own Worker bundle: QuickJS-WASM (about 1 MB of WASM per variant; Worker size limit 64 MiB uncompressed on both plans [DOC S18]).

## 2. Open-source sandboxes

Activity is the GitHub `pushed_at` and stars fetched today with `gh api repos/<owner>/<repo>` [OBS]. Install numbers are from `npm install` into my scratch folder [OBS].

| Sandbox | License | Activity (2026-10-15) | macOS on Apple silicon | Isolation | Startup | Resource cost | Fit for Weft |
|---|---|---|---|---|---|---|---|
| **E2B** SDK `e2b-dev/E2B`; infra now `e2b-dev/runtime` (was `e2b-dev/infra`) | Apache-2.0 (runtime, repo); SDK npm `e2b` 2.56.0 MIT | 14.4k stars, pushed 2026-10-14; runtime 1.7k stars, pushed today [OBS] | Cloud SDK: yes. Self-host "Embed" needs "a Linux machine with hardware virtualization"; "On a Mac, it runs inside a Linux virtual machine (Apple silicon M3 or newer, macOS 15 or ..." [DOC S20] | Firecracker microVM per sandbox, own cgroup and netns, nftables egress firewall with SNI/Host allow and deny lists [DOC S21] | Sandbox "is a resumed snapshot", memory paged lazily via userfaultfd [DOC S21]. Instinct's E2B box: "Startup finished in 265ms (kernel) + 992ms (userspace) = 1.258s" [3P S30] | Self-host stack: API, orchestrator, client-proxy, envd, PostgreSQL, Redis, ClickHouse, object storage [DOC S21]; Embed is "one machine, by design" via Docker Compose or Terraform for GCP/AWS/Azure [DOC S20]. Cloud Hobby: one-time $100 credits, no card, 20 concurrent sandboxes, 1 hour max session; Pro $150/month; $0.000014 per vCPU-s, $0.0000045 per GiB-s [DOC S22] | Too heavy to self-host for a demo. The cloud Hobby credits could back an optional adapter, but that adds a third-party key and network dependency. **Avoid for the foundation; copy the design ideas** (snapshot resume, egress allowlist, secrets never enter the VM) |
| **Daytona** | AGPL-3.0 (LICENSE at tag v0.190.0) [OBS]; `@daytonaio/sdk` npm 0.224.1 Apache-2.0 | Repo **archived**: "As of June 2026, Daytona's core development has moved to a private codebase. This repository will receive no further updates" [DOC S23] | Self-host was Docker based | Claims "dedicated kernel" per sandbox [DOC S23] | Claims "under 90ms from code to execution" [DOC S23] | Self-host is a full platform | **Avoid**: archived OSS, AGPL, cloud-first |
| **microsandbox** (`superradcompany/microsandbox`, formerly zerocore-ai) | Apache-2.0 | 8.7k stars, pushed today; npm `microsandbox` 0.7.8 published 2026-10-09 [OBS] | **Yes, verified** [OBS]. npm ships a prebuilt `@superradcompany/microsandbox-darwin-arm64` N-API binary; no daemon; no sudo | Hardware isolation via libkrun microVMs [DOC S24]; guest kernel `Linux 6.12.111`, 1 vCPU, 480 MB RAM by default, host `/Users` absent [OBS] | README claims "under 100 milliseconds" average boot [DOC S24]. Measured end to end through the CLI: first run with alpine pull 4.9 s; warm `msb run alpine -- echo` 1.49 s and 1.70 s; with `--no-net --mount-dir` 1.78 s [OBS] | 90 MB of node_modules; 11 to 15 MB per alpine home; about 480 MB guest RAM while running [OBS] | **Optional heavy tier locally.** Features that map to Weft: `--no-net`, `--net-rule allow@<target>` allowlists, `--secret-conf` ("Secrets That Can't Leak ... never enter the VM" [DOC S24]), snapshots and fork. Gotcha [OBS]: `MSB_HOME` under a long path fails ("Unix socket paths on this platform must be shorter than 104 bytes"); use a short home like `.data/msb` relative to a short repo path |
| **Apple `container`** (+ `apple/containerization` Swift package) | Apache-2.0 | 50.7k stars, pushed 2026-10-14; release 1.5.0 on 2026-09-29 [OBS] | Apple silicon only; "supported on macOS 26" (this Mac is 26.5.2) [DOC S25] | Each container is a lightweight Linux VM [DOC S25] | Not measured | Install is a signed `.pkg` that needs the administrator password to write under `/usr/local`, then `container system start` runs a system service [DOC S25] | **Not test-installed**: it needs sudo and a persistent system service, which a builder agent should not do unasked. Good alternative to microsandbox if Nitish installs it himself; no SDK for Node, so Weft would shell out to the CLI |
| **Docker** (plain) | Docker Engine Apache-2.0; Docker Desktop commercial terms | n/a | Docker Desktop runs a Linux VM; CLI installed here but **daemon not running** (`/var/run/docker.sock` missing) [OBS] | Shared Linux kernel inside Docker Desktop's VM: namespaces and cgroups, weaker than a VM per sandbox [INF] | Not measured (daemon down; starting Docker Desktop would affect other agents on this Mac) | Hundreds of MB to GBs for the Desktop VM [INF] | **Avoid as a requirement.** Needed only for Cloudflare Containers or Sandbox SDK local dev (Paid path) |
| **Docker + gVisor (`runsc`)** | Apache-2.0 | 19.7k stars, pushed today [OBS] | **No.** "gVisor supports x86_64 and ARM64, and requires Linux 5.6+"; install steps are apt and systemctl [DOC S26] | User-space application kernel intercepting syscalls [DOC S26] | n/a | n/a | Only relevant if Weft is ever hosted on a Linux VM |
| **Firecracker** | Apache-2.0 | 37.4k stars, pushed today [OBS] | **No.** Uses "the Linux Kernel Virtual Machine (KVM)" [DOC S27] | microVM, minimal device model [DOC S27] | Instinct's E2B Firecracker box: 1.258 s to systemd userspace [3P S30] | n/a | Linux hosting only; E2B is the way to consume it |
| **Anthropic `sandbox-runtime` (`srt`)** (`anthropics/sandbox-runtime`, formerly anthropic-experimental) | Apache-2.0 | 5.6k stars, pushed today; npm `@anthropic-ai/sandbox-runtime` 0.0.79 [OBS] | **Yes, verified** [OBS]. "`sandbox-exec` on macOS, `bubblewrap` on Linux" plus proxy-based network filtering [DOC S28] | OS-level process sandbox (Seatbelt profile), not a VM. Network is deny-all unless `allowedDomains` lists a domain; macOS profile allows only the proxy's localhost port [DOC S28] | 0.59 s for `srt true`, 1.09 s for a bash script with five probes [OBS] | 8.9 MB package [OBS] | **Use to wrap subprocesses** the executor spawns (git, any renderer, a future Python helper). Not a place to run untrusted JS in process |
| **isolated-vm** | ISC | 2.9k stars, pushed 2026-10-11; npm 7.0.1 [OBS] | **Fails on Node 25.9** [OBS]: node-gyp build error in `serializer_nortti.o`. README: Node 22 to 5.x/4.x, 24 to 6.x/5.x, 26 to 7.x, and odd-numbered Node versions "we can't support it at this time"; project is "in *maintenance mode*" [DOC S29] | Separate V8 isolate in process (real V8 security boundary, shares the process) | Fast (not measured: did not build) | Native addon | **Avoid**: the machine's Node is odd-numbered, and the project is in maintenance mode |
| **QuickJS in WebAssembly** (`quickjs-emscripten` 0.32.0, MIT) | MIT on npm (GitHub reports NOASSERTION for the repo) [OBS] | 1.7k stars, pushed 2026-07-23 [OBS] | **Yes, verified** [OBS] | Interpreter inside a WASM linear memory: no host APIs exist unless the host injects them; `typeof fetch`, `process`, `require` all `"undefined"`; memory limit and interrupt handler enforced; `while(true){}` returned `InternalError: interrupted` [OBS] | Sync module load 29 ms, runtime + context 6.6 ms, small eval 12.6 ms; async (asyncify) module 20 ms, eval with two awaited host calls 103 ms including 2 x 5 ms simulated I/O [OBS] | About 9 MB in node_modules for all variants (2.4 MB core package, 5.9 MB `@jitl` variants) [OBS] | **Default local and hosted sandbox for model-written JS.** Slower than V8 for heavy compute, irrelevant at payroll-demo data sizes. Deterministic, so scripted-provider tests can replay it. Gotcha [OBS]: tearing down an async runtime threw "QuickJSRuntime ... not found when trying to free HostRef"; dispose the context and runtime in a `try/finally` scope and add a teardown test |
| **Deno permissions** (`deno` 2.9.6 via the official `deno` npm package) | MIT | 108.7k stars [OBS] | **Yes, verified** [OBS] | With no flags `Deno.readTextFile`, `fetch`, `Deno.env.get`, `Deno.Command` all failed with `NotCapable`; `--allow-read=<dir>` re-enabled only that read [OBS]. Docs: `--allow-run` subprocesses and `--allow-ffi` escape the model; "When executing untrusted code, it is important to have more than one layer of defense" [DOC S31] | 0.09 s warm per run (first run 4.7 s) [OBS] | 81 MB binary [OBS] | Good second engine for full TypeScript with modern V8 speed: `deno run --no-prompt --allow-net=127.0.0.1:<executor-port>` gives exactly one door. Run it under `srt` for the second layer Deno's docs ask for. Not the default because it is a subprocess per run and an extra 81 MB |
| **Pyodide** (`pyodide` 314.0.7, CPython 3.14.2 in WASM) | MPL-2.0 | 14.9k stars, pushed today [OBS] | **Yes, verified** offline in Node [OBS] | WASM; virtual FS (`os.listdir('/Users')` raised `FileNotFoundError`) [OBS] | `loadPyodide()` 7.0 to 7.8 s on every cold load in Node; run 10 to 15 ms [OBS] | 13 MB package; 190 MB RSS after load [OBS] | Only if Python is a hard requirement and microVMs are off. Keep one warm instance per process if used |
| **Wasmtime** (WASI) | Apache-2.0 | 18.7k stars, pushed today [OBS] | Supported upstream [DOC]; not installed today | WASM plus WASI capabilities | Not measured | n/a | Only useful if Weft compiles tools to WASI; no need now |
| **nsjail** | Apache-2.0 | 4.2k stars [OBS] | **No**: "Linux process isolation tool using namespaces, resource limits, and seccomp-bpf" [DOC S32] | Namespaces + seccomp | n/a | n/a | Linux hosting only |
| **bubblewrap** | LGPL-2.0-or-later (GitHub reports NOASSERTION) | 9.1k stars [OBS] | **No**: built on Linux user namespaces [DOC S33] | Namespaces | n/a | n/a | Linux only; `srt` already uses it on Linux |
| **workerd** (open-source Workers runtime) | Apache-2.0 | 9.0k stars; npm `workerd` 1.20261015.1 [OBS] | **Yes, verified** via wrangler 4.151.0 (wrangler plus workerd plus miniflare about 160 MB of node_modules) [OBS] | V8 isolates, capability bindings, `globalOutbound: null` | 19 to 45 ms per fresh Dynamic Worker [OBS] | A long-running workerd process per dev server | Strong local option if Weft were going to Cloudflare Paid. On Free hosting the same code would not deploy, so it does not buy portability. Keep as the upgrade path |

## 3. Test installs on this Mac (what I ran)

All in my scratch folder; every server or VM I started was stopped; `pgrep` shows none of my processes; no repo files touched.

### 3.1 QuickJS-WASM bridge (sync and async)
- `npm install quickjs-emscripten` (0.32.0). Sync: `newQuickJSWASMModule()`, `rt.setMemoryLimit(32 MiB)`, `rt.setMaxStackSize(512 KiB)`, `setInterruptHandler(shouldInterruptAfterDeadline(...))`, one injected `weftCall(name, argsJson)`. Model-style code aggregated gross pay by state through `weftCall('people.list')`; `typeof fetch/process/require` were all `"undefined"`; an infinite loop was interrupted.
- Async: `newQuickJSAsyncWASMModule()`, `vm.newAsyncifiedFunction('weftCall', async ...)`, `await vm.evalCodeAsync(code)`. The guest code stays synchronous-looking (`const run = call('payroll.get_run', {...})`) while the host awaits real I/O; a call to an unavailable command returned `{refused: 'UNAVAILABLE'}` as data to the guest. This is exactly the executor-RPC shape Weft needs.

### 3.2 microsandbox microVM
- `npm install microsandbox` (0.7.8, 6.5 s, 90 MB). `MSB_HOME` must be short (104-byte Unix socket limit).
- `msb run --no-tty --timeout 90 alpine -- sh -c '...'`: guest `Linux 6.12.111`, `nproc` 1, 480 MB RAM, host paths absent, default network allowed (`wget https://example.com` worked).
- `msb run --no-net --mount-dir <host_ws>:/workspace alpine -- ...`: `wget: bad address 'example.com'`, file written to `/workspace` appeared on the host. Then `msb rm`, `msb ls` showed "No sandboxes found."

### 3.3 Anthropic sandbox-runtime
- Settings: `network.allowedDomains: []`, `filesystem.denyRead: [<fake vault dir>, ~/Developer, ~/.ssh]`, `allowWrite: [<workspace>]`.
- Results: read of fake vault rc=1, `ls ~/Developer` rc=1, `curl https://example.com` rc=56 (proxy refused), write to workspace rc=0, write to `$HOME` "Operation not permitted", `python3` still runs. I never pointed it at the real secrets file.

### 3.4 Worker Loader in local wrangler dev
- `wrangler.jsonc` with `"worker_loaders": [{ "binding": "LOADER" }]`; parent exports `class WeftTools extends WorkerEntrypoint { async call(name, args) {...} }`; loader call `env.LOADER.get(id, async () => ({ compatibilityDate, mainModule: "m.js", modules: { "m.js": modelCode }, env: { WEFT: ctx.exports.WeftTools({ props: {} }) }, globalOutbound: null }))`, then `w.getEntrypoint().fetch(...)`.
- Result: aggregation correct through `env.WEFT.call`, `fetch` blocked with the capability error, 45 ms then 19 ms. Server on 127.0.0.1:8799 stopped afterwards.

### 3.5 Deno, Pyodide, isolated-vm
- Deno 2.9.6 from npm: all four probes `NotCapable` with no flags; 0.09 s warm.
- Pyodide 314.0.7: works offline in Node, 7 to 8 s load each process, 190 MB RSS.
- isolated-vm 7.0.1: native build fails on Node 25.9.0 (odd-numbered Node unsupported per README).

### 3.6 Not installed, and why
- Apple `container`: signed pkg needs the admin password and starts a system service.
- Docker, gVisor, Firecracker, nsjail, bubblewrap: daemon down or Linux only.
- E2B Embed: needs a Linux VM with nested KVM plus a multi-service stack; out of the 30 minute budget and not a fit.

## 4. Reference designs: Instinct and Muse

- **Instinct (E2B Firecracker), from a third-party teardown [3P S30]:** observed `systemd-detect-virt` = kvm; Firecracker inferred from the kernel command line (`pci=off`, virtio-mmio), empty DMI and `tap0`; E2B inferred from the `e2b.local` hostname and `/.e2b`. Observed Ubuntu 22.04.5, systemd PID 1, 2 vCPU, 1.9 GB RAM, 29 GB disk, XFCE; processes `agent-exec-server` (runs bash and code) and a `tools` daemon whose `--base-url` is `api.instinct.com`. Inferred: no model inference in the box (no model names in `strings`); tool calls are GraphQL requests executed server-side. Observed: `/etc/instinct-aws-creds` holds short-lived STS credentials; `/memory` is a git repo of Markdown pushed to S3 as one git bundle per user. Author's summary: "a git repo in S3. The machine is throwaway." Already summarized for Weft in `research/agent.md` section 2.
- **Meta Muse (per-user VM), press only [3P S34, S35]:** launched 2026-09-08; each user gets a dedicated cloud VM ("Muse Secure VM") with its own browser, file system and terminal; a separate "Sentinel" agent controls outbound activity; sending email or paying needs user approval. No primary technical source or teardown found; treat as marketing-level detail.
- **Pattern both share, which Weft keeps:** the box is disposable and holds no long-lived credential; durable state lives outside (S3 bundle, server DB); every consequential action leaves the box as a request to a server that applies policy and approvals. Instinct still puts short-lived STS credentials in the box; **Weft should not** (nothing in the box needs a credential, since all reads and writes are executor calls) [INF].

## 5. Recommended Weft sandbox design

### 5.1 Principle: the sandbox is a hand without keys
The sandbox is a compute place for model-written code. It holds **no credentials**, has **no ambient network**, and has **exactly one egress: `weft.call(command, args)`**, which the host turns into `Executor.exec({ principal: <run's agent principal>, surface: "sandbox", command, args, parent_step_id })`. The executor applies the same registry tiers (`executable`, `delegated`, `unavailable`), grants, approval policy and money ceilings as a direct model tool call, and appends the same hash-chained action rows. A sandbox call can never do more than the agent could do with a direct tool call; it only lets the agent do many reads and one aggregation in one model turn (the Code Mode benefit [DOC S11]).

### 5.2 What runs inside vs outside

| Inside the sandbox | Outside (host, executor side) |
|---|---|
| Model-written analysis code: payroll variance checks, multi-state withholding comparisons, headcount and cost rollups, anomaly explanations, "why is this NY raise flagged" style computations over executor read results | The brain: provider calls (OpenAI Luna default, Claude, local), prompts, transcripts |
| A **read-only snapshot** of the company memory repo (in QuickJS: a frozen `{path: text}` map plus a `memory.grep` helper; in a microVM: a read-only `--mount-dir` of a temp checkout). Never the live `.git` | The **memory writer** and the live repo `.data/companies/<id>/memory/` (SPEC section 9.4: validated writer, sim-clock commits, PII and secret refusals). The sandbox proposes notes by calling `weft.call('memory.write_note', ...)`, which goes through that writer |
| Report assembly: code returns structured data (rows, columns, totals, narrative bullets) | Rendering and storing files (CSV, PDF, XLSX) from that data in the executor with fixed templates, recorded as an action with a content hash. Deterministic and testable; the model never writes bytes to disk directly |
| Scratch state for one run (variables, intermediate tables); discarded when the run ends | Domain SQLite DB, action log, proposals and decision inbox, approvals, vault, simulators, routines scheduler, MCP server, public API |
| Nothing with a secret: no OPENAI_API_KEY, no vault values, no simulated bank numbers, no SSNs (the executor's read commands already mask them) | `WEFT_SECRETS_FILE` loading, vault decryption, `credential_ref` resolution inside simulator calls |

### 5.3 Contract for the `code.run` command (proposal for the harness architect)
- Registry entry `code.run` (wire name `code__run`), effect `compute`, no domain writes, tier `executable` for main and task agents.
- Input: `{ language: "js", source, purpose, inputs? }`. Output: `{ ok, value (JSON, max 64 KB), logs (max 8 KB), calls: [{command, outcome, ms}], refused?: { code } }`.
- Limits (defaults to tune): heap 32 MB, wall deadline 2 s CPU via interrupt handler, max 25 `weft.call`s per run, max 256 KB total result bytes returned from calls, no `eval` of further network code (there is no network), no module loader except a vetted `weft` prelude.
- Allowed commands from inside: registry entries whose effect is `read`, plus `propose`-type entries (which only create proposals). `apply`-type commands and anything approval-gated return `{refused: "SANDBOX_NOT_ALLOWED"}` as data; the model then has to call the tool directly so the normal approval UI applies. All calls are logged as child run steps of the `code.run` step.
- The prelude is generated from the command registry as a typed API (`weft.payroll.getRun({id})`, `weft.people.list({...})`) so the model writes against a TypeScript-shaped surface (Code Mode's main idea [DOC S11]); the scripted provider's fixtures include `code.run` steps so CI exercises the bridge without a live model.
- Injection posture: content from notices or emails can reach the model and therefore its code, but the code has no network and no secrets; the worst it can do is read what the agent may read and create proposals a human must approve.

### 5.4 Tier 1: local build today (verified installable)
1. `quickjs-emscripten` async variant in the executor process (or a `worker_threads` worker per run if the main loop must stay responsive). One runtime and context per `code.run`, disposed in `finally`.
2. `srt` wrapping any child process the executor spawns (git operations on the memory repo, a future renderer), with `denyRead` on the secrets file directory and the vault, `allowWrite` limited to `.data/companies/<id>/` and a tmp folder, `allowedDomains: []`. Note: the memory writer runs git itself and is trusted code; `srt` there is defense in depth, not the primary control.
3. Optional, flag `WEFT_SANDBOX=microvm`, off by default: microsandbox for Python or heavy libs. RPC out via a mounted spool directory (`/workspace/rpc/req-*.json` and `res-*.json` handled by the host) or via `--net-rule` allowing only the host's executor port. **[UNVERIFIED]** I tested `--no-net` and `--mount-dir`, not a host-port allow rule. `--secret-conf` exists but Weft should not need it.
4. Not used: Docker, Apple container (needs sudo), isolated-vm, Pyodide (unless Python becomes mandatory without microVMs).

### 5.5 Tier 2: free hosted Cloudflare deployment later
- Front Worker (thin; 10 ms CPU, 50 subrequests on Free [DOC S18]) authenticates and routes `/companies/:id/*` to that company's **SQLite Durable Object** (Free supports SQLite DOs only [DOC S12]).
- The company DO is the agent home: run store, proposals, inbox, action log rows, routines via DO alarms; the executor runs in the DO; the QuickJS sandbox runs inside the DO request (30 s CPU per request [DOC S13]). Model calls go out from the DO with the key held as a Worker secret, outside the sandbox.
- Persistence: domain data in DO SQLite (5 GB per account, 100,000 rows written per day on Free [DOC S12]); memory repo as a git bundle in R2 (Instinct pattern [3P S30]) or as DO blobs if R2 needs a card; generated files in R2 (10 GB-month free [DOC S16]).
- Paid-only upgrade path if Nitish ever changes his mind: replace QuickJS with Dynamic Workers (`env.LOADER.get`, `globalOutbound: null`, `env: { WEFT: ctx.exports.WeftTools(...) }`, verified locally [OBS]) and add Sandbox SDK containers for Python. The `code.run` contract above does not change.
- **[UNVERIFIED, INF]** quickjs-emscripten inside a deployed Worker or DO on Free was not deployed today. It is plain WASM and should work, but one deploy smoke test is needed (module instantiation in Workers may require importing the `.wasm` as a module rather than fetching it).

## 6. Patterns for Weft

**Copy**
- Brain and hands split with one narrow RPC out of the box (Instinct's `tools` daemon calling the server [3P S30]; Code Mode's bindings-only egress [DOC S11]).
- No ambient network inside the sandbox; capability injection only (`globalOutbound: null` [DOC S10]; QuickJS has nothing unless injected [OBS]).
- Secrets never enter the box; the host adds them on the way out (Code Mode "API keys" stay with the supervisor [DOC S11]; E2B "Secrets are metadata-only on the control plane" [DOC S21]; microsandbox "never enter the VM" [DOC S24]).
- The box is disposable; durable state lives outside (Instinct's git bundle in S3 [3P S30]; Cloudflare container disks "end with the instance" [DOC S7]).
- Present tools to the model as a typed code API generated from the registry (Code Mode [DOC S11]).

**Adapt**
- Instinct's full Linux VM per user becomes an in-process WASM interpreter per run for the default path, because Weft's sandboxed work is data analysis over executor reads, not browsing or shell work.
- Instinct's agent writes memory with a free shell and `git commit`; Weft's sandbox sees a read-only snapshot and proposes notes through the validated memory writer.
- E2B and microsandbox egress allowlists become "the only allowed destination is the executor".
- Muse's Sentinel controlling outbound activity [3P S34] maps to the executor's tier and approval checks on every `weft.call`.

**Avoid**
- Putting even short-lived credentials in the box (Instinct's STS file [3P S30]).
- Any sandbox that needs sudo, a system daemon or Docker Desktop for the default path on Nitish's Mac.
- Building on Paid-only Cloudflare products (Sandbox SDK, Containers, Dynamic Workers, Code Mode runtime, DO Facets) for the hosted plan.
- Native-addon sandboxes tied to even Node versions (isolated-vm) while the machine runs Node 25.
- Letting sandbox code apply changes; it reads and proposes, humans approve.

## 7. Open questions
1. Does R2 activation on a Workers Free account require a payment method? (Pricing page silent [DOC S16].) Nitish to check in the dashboard.
2. Durable Object per-object storage on Free: the limits table says 10 GB, the FAQ says 1 GB [DOC S13]. Irrelevant at demo size, but note it.
3. Does quickjs-emscripten's async variant instantiate cleanly in a deployed Worker or DO on Free, within the 10 ms CPU of the front Worker and the DO's 30 s? Needs one deploy test.
4. Should Python be supported at all in the foundation? If yes, microsandbox (local) has no Free hosted twin; Pyodide in a DO would be the only Free option and its 7 s load is likely too slow for a DO request [INF].
5. microsandbox host-port allow rule (`--net-rule allow@...`) for the executor RPC is untested.

## Sources

- S1 Sandboxes landing: https://developers.cloudflare.com/sandbox/
- S2 Containers pricing: https://developers.cloudflare.com/containers/pricing/
- S3 Sandbox SDK get started: https://developers.cloudflare.com/sandbox/sdk/get-started/index.md
- S4 Containers local dev: https://developers.cloudflare.com/containers/local-dev/
- S5 Sandbox SDK architecture: https://developers.cloudflare.com/sandbox/sdk/concepts/architecture/index.md
- S6 Containers overview: https://developers.cloudflare.com/containers/
- S7 Sandbox lifetime: https://developers.cloudflare.com/sandbox/concepts/lifetime/index.md
- S8 Dynamic Workers pricing: https://developers.cloudflare.com/dynamic-workers/pricing/index.md
- S9 Dynamic Workers limits: https://developers.cloudflare.com/dynamic-workers/platform/limits/index.md
- S10 Dynamic Workers getting started: https://developers.cloudflare.com/dynamic-workers/getting-started/index.md (index: https://developers.cloudflare.com/dynamic-workers/llms.txt)
- S11 Code Mode blog (2025-09-26): https://blog.cloudflare.com/code-mode/
- S12 Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- S13 Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- S14 Durable Object Facets: https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/index.md
- S15 Browser Rendering pricing: https://developers.cloudflare.com/browser-rendering/pricing/
- S16 R2 pricing: https://developers.cloudflare.com/r2/pricing/
- S17 Agents SDK: https://developers.cloudflare.com/agents/ ; repo https://github.com/cloudflare/agents
- S18 Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- S19 Sandbox SDK limits: https://developers.cloudflare.com/sandbox/sdk/platform/limits/index.md
- S20 E2B Embed README: https://github.com/e2b-dev/runtime/blob/main/embed/README.md
- S21 E2B runtime README: https://github.com/e2b-dev/runtime
- S22 E2B pricing: https://e2b.dev/pricing
- S23 Daytona README (archived): https://github.com/daytonaio/daytona ; license at https://github.com/daytonaio/daytona/blob/v0.190.0/LICENSE
- S24 microsandbox README: https://github.com/superradcompany/microsandbox
- S25 Apple container README: https://github.com/apple/container ; release 1.5.0 https://github.com/apple/container/releases
- S26 gVisor install: https://gvisor.dev/docs/user_guide/install/
- S27 Firecracker README: https://github.com/firecracker-microvm/firecracker
- S28 sandbox-runtime README: https://github.com/anthropics/sandbox-runtime (also in the npm package `@anthropic-ai/sandbox-runtime@0.0.79`)
- S29 isolated-vm README: https://github.com/laverdet/isolated-vm
- S30 Instinct teardown (third party): https://rohanadwankar.github.io/posts/platforms#instinct ; Weft summary in `research/agent.md` section 2
- S31 Deno security: https://docs.deno.com/runtime/fundamentals/security/
- S32 nsjail README: https://github.com/google/nsjail
- S33 bubblewrap README: https://github.com/containers/bubblewrap
- S34 Muse (press): https://aicybr.com/blog/meta-muse-personal-ai-agent ; https://www.vktr.com/ai-platforms/meta-launches-muse-a-personal-ai-agent-that-browses-the-web-makes-purchases/
- S35 Muse (press): https://www.vellum.ai/blog/official-muse-breakdown
- Other repos checked for license and activity with `gh api`: https://github.com/justjake/quickjs-emscripten , https://github.com/denoland/deno , https://github.com/pyodide/pyodide , https://github.com/bytecodealliance/wasmtime , https://github.com/cloudflare/sandbox-sdk , https://github.com/cloudflare/workerd , https://github.com/libkrun/libkrun , https://github.com/google/gvisor , https://github.com/apple/containerization
- Local context: `SPEC.md` sections 9.3 and 9.4 (executor pipeline, memory repo writer), `research/agent.md` sections 0 and 2.
