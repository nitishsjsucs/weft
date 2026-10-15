# Meta Muse as a model for the Weft harness

Research for the Weft harness architect, written 2026-10-15. Read this instead of redoing the reading. Every fact carries a source tag; tags resolve in section 1. Section 12 is the actionable part (copy, adapt, avoid, mapped to SPEC.md sections). Section 11 answers Nitish's request to look at open-source sandboxes and Cloudflare's free tier.

Muse is Meta's consumer personal agent, launched 2026-09-08 in the US on iOS, Android, web and WhatsApp [M-NEWS]. Its codebase name is Hatch [M-SEC]. Internals use `JARVIS_*` env vars, call a VM a "hatchling", and the bootstrap cert the "yolk" [T].

## 0. The ten things that matter for Weft

1. **Two security domains, one box.** The agent harness, its workspace and every tool the model can run live in a clipped container (the "runtime cell"). Credentials, the database, the permission authority (Sentinel), safety classifiers, the browser broker and the inference proxy live outside it and are reachable only over Unix sockets authenticated by kernel peer credentials [M-SEC][T]. Meta frames it as two isolated security domains on one box, not an agent with root [M-SEC].
2. **A separate permission authority the model cannot address.** Sentinel is the sole authority for connector actions and all network egress. Muse proposes; only Sentinel grants. Sentinel answers allow, deny or ask [M-SEC].
3. **Approvals are out of band and are capabilities.** An "ask" stops that execution, Sentinel sends the request straight to the client app, the user answers in a dialog that is not the chat, and the answer goes back to Sentinel. Grants are bound to connector/destination and use case and come as one-time, session, task, time-bounded or perpetual; later calls must match the grant exactly [M-SEC]. Product design calls deterministic approval cards non-negotiable [M-DES].
4. **The purpose shown to the user is built by Sentinel from structured fields** (connector, method, class of action, scope, what the user asked), not taken from the model's prose [M-SEC].
5. **Tainted egress.** Each tool process starts clean and becomes tainted when it reads user data; only clean processes keep narrow auto-allow; tainted or unverifiable ones fall back to approval. Implemented with eBPF cgroup programs plus LSM hooks [M-SEC].
6. **The agent never sees real secrets.** authd mints surrogate tokens; Sentinel swaps in the real credential at the network boundary after authorization [M-SEC]. Purchases use single-use card numbers bound to one merchant, one amount, short validity, with a human approval every time [M-SEC].
7. **Named, instrumented loop stages with per-stage timeouts and Postgres checkpoints**, so a turn survives the VM being replaced mid-turn; eager background compaction on a dedicated model [T].
8. **Memory is Markdown as the source of truth plus a derived hybrid index** (Postgres rows with `path#L<line>` citations, 384-dim local embeddings, tsvector keyword search, a local reranker), used both by a pre-inference recall step and a `memory_search` tool [T].
9. **Proactivity is bounded by a "worth surfacing" check**: background work runs on schedules and events, then evaluates whether the result is meaningfully new or needs input before notifying [M-DES]. A per-user `PROACTIVE_PREFERENCES.md` is read in full before each daily edition [T].
10. **Where it went wrong** (reported): an agent explaining its own data provenance incorrectly, "forget" that does not erase and instructions not to say so, hourly relationship dossiers on non-users, approval prompts so frequent people click "Always allow", and monitoring tasks that silently stopped [TIME][HN2][HS][IMP]. Weft should copy the architecture and avoid the product behaviours.

## 1. Sources and evidence labels

Evidence labels used on every claim:

- **[OBS]** observed directly from a shell inside a Muse VM by Rohan Adwankar on the evening of 2026-09-10 PDT (journal timestamps "Sep 10 21:14"), posted to HN 2026-09-11. This is a third party, but the evidence is command output from the artifact itself. Where he interprets rather than shows output, it is marked **[OBS, interp]**.
- **[META]** stated by Meta (official posts, help center).
- **[3P]** third-party hands-on reports (integration vendors who connected their services).
- **[PRESS]** press reporting, mostly from internal instructions or internal posts reviewed by reporters.
- **[INF]** my inference, not stated by any source.

| Tag | Source | Type |
|---|---|---|
| T | https://rohanadwankar.github.io/posts/sandbox2.html ("What's in a Muse?") | OBS teardown |
| T0 | https://rohanadwankar.github.io/posts/platforms.html (prior post: Claude Code and Instinct VMs; already summarized in research/agent.md) | OBS teardown |
| HN1 | https://news.ycombinator.com/item?id=49658976 (teardown thread, author comments add skill-scope details) | OBS + comments |
| HN0 | https://news.ycombinator.com/item?id=49605644 (prior thread; E2B staff comments) | comments |
| HN2 | https://news.ycombinator.com/item?id=49893709 (thread on AppleInsider "Muse blatantly ignores users permissions"; article itself returned 403) | PRESS + comments |
| M-SEC | https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse (Tarek Sheasha, 2026-09-08; security.muse.ai redirects here) | META |
| M-NEWS | https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ (2026-09-08, updated 2026-09-30) | META |
| M-DES | http://introducing.muse.ai ("How We Designed Muse", Mona Sarantakos with Christine Awad, Sept 2026) | META |
| M-WON | https://research.meta.ai/blog/muse-wonder (2026-10-12, Muse Wonder models, Active Memory and Active Focus) | META |
| M-HC1 | https://www.meta.com/help/artificial-intelligence/1687253048996149/ (Help Center: connectors, custom connectors) | META |
| M-HC2 | https://www.meta.com/help/artificial-intelligence/2225571704857152/ (Help Center: data controls, forget, memory files) | META |
| TIME | https://time.com/article/2026/10/06/meta-muse-ai-agent-privacy/ (Harry Booth, from Muse's internal instructions) | PRESS |
| LDS | https://letsdatascience.com/news/meta-muse-creates-profiles-of-users-contacts-15585c25 (summary of WIRED 2026-10-03, https://www.wired.com/story/muse-creates-detailed-profiles-of-all-your-friends-and-family/, which I could not fetch) | PRESS, secondhand |
| HS | https://hindsight.vectorize.io/blog/2026/09/28/meta-muse-agent-memory (Ben Bartholomew, connected Muse to an MCP memory server) | 3P |
| HS-CP | https://github.com/vectorize-io/hindsight/blob/main/hindsight-integrations/meta-muse/connect-prompt.md | 3P |
| PAR | https://parallel.ai/articles/meta-muse-custom-integrations (2026-09-14, connected Muse to an MCP server) | 3P |
| ZAP | https://zapier.com/blog/zapier-connector-in-muse/ | 3P (vendor PR) |
| VEL | https://www.vellum.ai/blog/official-muse-breakdown (competitor marketing; adds nothing beyond M-SEC) | 3P, low value |
| INN | https://innfactory.ai/en/ai-harness/muse/ (describes **Muse Code**, Meta's coding CLI, not the consumer agent) | 3P, different product |
| IMP | https://www.implicator.ai/meta-muse-ai-agent-internal-security-flaws/ (relays Reuters on internal dogfooding posts) | PRESS, secondhand |
| CB | https://cryptobriefing.com/meta-muse-filesystem-download-exploit/ (relays The Verge, https://www.theverge.com/ai-artificial-intelligence/1000222/meta-muse-ai-filesystem, unreachable) | PRESS, secondhand |
| CF-DW | https://developers.cloudflare.com/dynamic-workers/pricing/ , /dynamic-workers/usage/egress-control/ , /dynamic-workers/getting-started/ , /dynamic-workers/platform/limits/ | vendor docs |
| CF-CT | https://developers.cloudflare.com/containers/pricing/ | vendor docs |
| CF-W | https://developers.cloudflare.com/workers/platform/pricing/ | vendor docs |

Not found or not usable: no Meta engineering post beyond M-SEC and M-DES describes the agent loop; no Meta developer docs exist for the consumer agent's tools (there is no public API for driving a Muse [PAR]); WIRED, The Verge, AppleInsider and Inc returned 403 or blocked fetches, so their claims appear only through secondary summaries and are marked as such. Muse Code docs (INN) describe a different product and are used only where noted.

## 2. Execution substrate

### 2.1 Observed [OBS, T]

**Machine.** A Cloud Hypervisor microVM (DMI vendor and product "Cloud Hypervisor"; full PCI, virtio-pci) rather than Firecracker. 2 vCPUs, 7.7 GiB RAM, stock Ubuntu kernel `7.0.0-26-generic`. Kernel cmdline: `root=/dev/vda rootfstype=btrfs ro`, cloud-init nocloud datasource at `169.254.169.254`, `lsm=landlock,lockdown,yama,integrity,apparmor,bpf`, `systemd.set_credential=vmm.notify_socket:vsock-stream:2:512`. Virtio devices: four block disks, net, rng, vsock, balloon with free-page reporting. [T, interp] free-page reporting is what makes an always-on per-user VM affordable: an idle hatchling costs its roughly 2 GB working set, not its 8 GB allocation.

**The cell.** The shell lands as root in a `systemd-nspawn` container named `htch-runtime`. Cell root is uid 131072 on the VM (user namespace). `NoNewPrivs: 1`, seccomp mode 2 with 4 filters, `io_uring_setup` returns EPERM, no `CAP_SYS_PTRACE`, `CAP_NET_ADMIN`, `CAP_NET_RAW`, `CAP_SYS_MODULE`. Each exec the agent runs gets its own mount namespace. VM-side services and the cell share a PID namespace but not a mount namespace: `hatch daemon` and `hatch-execd` show PPID 0 in the cell (started on the VM and nsentered in), and their `/proc/<pid>/ns` and `/proc/<pid>/root` are unreadable from cell root. The cell's `default.target` wants only `hatch-execd.socket`; the only running service inside is journald. Everything else is bind-mounted in as Unix sockets.

**Disks.**

| Device | Size | Role | Protection |
|---|---|---|---|
| vda | 7.3G | VM root, btrfs, read-only, built with mkosi | ro |
| vdb | 7.5G | overlay upper (writable scratch for `/`) | dm-crypt plain, throwaway key |
| vdc | 587M | "hatch image": `/opt/hatch` daemon, tools, skills, models | squashfs on dm-verity ("measured rootfs") |
| vdd | 100G | "Reliable Volume" (RV): `/home/hatch`, `/var/lib/hatch`, Postgres data | LUKS2 |

**VM-side services:** `spawnd`, `sentinel`, `authd`, `hatch-safety`, `postgres`, `browser-broker`, `ingress-rev-proxy`.

**Boot and assignment.** VMs boot with no owner (`JARVIS_IS_ASSIGNED=0`, "identityless preboot"). A user is attached by `spawnd rv-graft`, which verifies the RV, checks a resume handoff marker, ensures an os-intent ledger directory, and writes a boot-id-stamped `rv-identity-ready` marker. `hatch-prewarm` runs `vmtouch -t` over Postgres, the daemon binary, nspawn and the cell's loader/libc under a 256 MiB budget and 10 s deadline, fail-open. A control-plane health gate requires `is-system-running` to be exactly `running`, so nothing on this path may fail a unit. Distro `apt-daily`/`unattended-upgrades` timers are neutralised. The cell rootfs is reconciled against a KDL manifest (`runtime-cell.kdl`, about 110 apt packages including build-essential, libreoffice nogui, tigervnc, xvfb, cloudflared, nodejs 24). Packages the agent installs are recorded as intent in an append-only ledger on the RV and replayed at boot rather than persisted in the rootfs. Identity, channel and region (`JARVIS_VM_COMPUTE_REGION=scu`) arrive by cloud-init metadata; readiness goes to the VMM over vsock `sd_notify`.

**Measured timings** (one replacement): cell `default.target` 13 s after kernel boot, RV grafted 21 s, identity-specific CA anchors 35 s, `execution-ready` marker 39 s. `systemd-analyze` in the cell: 2.212 s userspace.

**Lifecycle and rollout.** The harness is a "live-update bundle" with its own trust root, versioned separately from the VM image, on a CD channel (`JARVIS_CD_CHANNEL=alpha` on the author's VM). In one evening the shell dropped three times; each time the box had a new boot time, and two of the three carried a new harness build (`17400c3e011` to `5d489a6707a` to `052113f66d3`). Deploy = pre-booted fresh hatchling with the new bundle, graft the RV, tear down the old one, about 40 s outage; the home directory came back with every file intact and the same timestamps, because nothing durable lives on the VM. `/usr/sbin/reboot` is replaced with a script explaining that the VMM does not survive a guest reset, so "reboot" means "replace this VM" (measured, per the script's comment).

**Inbound.** Every VM has a public FQDN `<uuid>.metaaivm.com` (domain registered 2026-02-26) that CNAMEs to Meta's edge (`edge-metaclaw.c10r.facebook.com`). Inside, `ingress-rev-proxy` speaks Noise_XX: `:443` for infra (`health`, `version`, `journal`, `rescue`, `yolk`), `:4431` for the data plane (`ping`, `v1/noise`, `spaces`). The phone app holds a persistent Noise session to the VM. `spaces` serves web apps the agent builds (`space.json` build format, four `space-*.sock` sandboxes). [T, interp] the "responding" bubble appears instantly because admission is a few local Postgres writes and the typing indicator fires there, before prompt assembly.

**Egress.** One veth `host0` (198.19.0.2/30); the gateway `hatch-egress-proxy` (198.19.0.1) is also DNS and the proxy. `HTTPS_PROXY` points at Sentinel on :3128 with a per-boot rotated password. All CA env vars (`CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`, `AWS_CA_BUNDLE`) point at `/run/hatch/egress-tls/ca-bundle.pem`; TLS is MITM'd by "Hatch Sandbox Egress CA". Direct TLS fails; non-standard-port CONNECTs are accepted then held; DNS returns fake IPs from 198.18/15 so every connection can be attributed to a hostname at the proxy. An eBPF `connect4/connect6` cgroup hook (`spawnd attach-cell-gate`) is the floor under Sentinel: composed with `BPF_F_ALLOW_MULTI` so a dead Sentinel does not mean ungoverned link-local, RFC1918 or CGNAT reach. Policy is per host: a managed allowlist (`managed-internal-network-policies.yaml`) plus a HITL prompt for anything off it. A comment in the manifest records a fleet-wide "HITL prompt storm" on 2026-08-15 caused by unattributed system traffic to `cli.github.com`, which is why apt timers were disabled. The inference endpoint is never reachable from the cell (`api.anthropic.com` answers 404 through the proxy, keyless; the inference socket is not mounted in the cell).

**Socket inventory** (compiled into the daemon; every one a bind-mount from the VM side, cell sees only a few): `daemon/http-api.sock`, `realtime-protocol.sock`, `rtc-stats.sock` (app via ingress); `proxy/inference.sock` (models); `proxy/stefi.sock` (Meta control plane: browser leases, connector OAuth consent, WhatsApp pairing, push); `sentinel/egress-approvals-admin.sock`, `daemon-egress-approvals.sock`; `safety/security.sock` (classifier ensemble); `auth/authd.sock`, `vault-encrypt/encrypt.sock`, `whatsapp-keyd/keyd.sock`; `browser-broker/browser-broker.sock`, `research-browserd.sock`, `daemon/browser-control.sock`; `rtc/realtime.sock`, `voice-genui-decision.sock`, `present-widget.sock`; `checkout-spend/checkout-spend.sock`, `credit-watcher.sock`; `cron-store/control.sock`, `noded/control.sock`, `tailscale/control.sock`, `ssh-access.sock`; `telemetry/telemetry.sock`, `bugreport.sock`, `daemon/metrics.sock`; `sandbox/space-{inference,media,web-search,privileged}.sock`; `exec/execd.sock`, `daemon/enter-tool-environment.sock`; `privsep/<tool>.sock` x60.

### 2.2 Meta states [META]

- Each user gets a dedicated VM, an isolated Linux box with a browser and enough resources to compile agent-written code, develop custom skills and run concurrent sub-agents and crons [M-SEC]. Product name "Muse Secure VM"; it houses both the agent and the person's data and connected-service credentials [M-NEWS].
- Cell root maps to an unprivileged host user; the cell has its own Debian root filesystem, a virtual NIC, filtered syscalls (no io_uring) and limited capabilities (no `CAP_SYS_PTRACE`, no `CAP_NET_ADMIN`) [M-SEC]. (The teardown saw Ubuntu inside the cell; Meta says Debian. Unresolved.)
- Outside the cell, as separate systemd units: `hatch-safety` (independent models and classifiers on inference requests and responses), `privsep` workers (built-in connector code with scoped privileges), `hatch-authd` (credential storage and surrogation), Sentinel, a Postgres database separate from both the cell and the credential store, and constrained proxies for inference and telemetry. All IPC is Unix sockets with `SO_PEERCRED` and peer ACLs [M-SEC].
- Clients connect directly to the VM over a secure transport. The VM is the system of record; limited data leaves for inference and telemetry [M-SEC].
- VM data is backed up continuously [M-SEC] ([OBS] btrfs snapshot strings in spawnd and the daemon [T]).
- Today Meta personnel access is restricted by operational policy only; a "Muse Confidential VM" meant to cryptographically prevent Meta access is planned for later in 2026, in testing, with design and source shared with external auditors [M-SEC][M-NEWS].

## 3. Harness and model split

### 3.1 Observed [OBS, T]

- **One 327 MB Rust binary** `/opt/hatch/bin/hatch`. Dependencies from embedded Cargo paths: tokio, hyper, axum, tokio-tungstenite, reqwest, rustls, h2; sqlx (Postgres and SQLite) and sqlparser; `genai` (provider-agnostic Rust LLM client); `ort`, fastembed, tokenizers, hf-hub, ndarray (local classifiers and embeddings); `boa_engine` (a JS engine); seccompiler; tree-sitter, scraper, html5ever, lopdf, calamine, image; jsonschema, schemars, moka, prometheus, tracing-subscriber. Zero strings for langgraph, langchain, rmcp or modelcontextprotocol.
- **Models named in the binary:** `avocado-5.16-v4`, `avocado-memory-flush-v1`, `claude-opus-4-6`, `claude-opus-4-8`, `claude-sonnet-4-6`, `gpt-5.6-sol`, `gpt-5.5-codex`. Transport is Meta's internal gateway `ipnext` (`ipnext/stream.rs`, `ipnext/proxy_readiness.rs`), plus Anthropic `/v1/messages` and OpenAI Responses code paths. Providers are first-class (separate knobs `JARVIS_ANTHROPIC_TIMEOUT_MS`, `JARVIS_AVOCADO_CONTEXT_WINDOW_TOKENS`). Inference leaves via `JARVIS_INFERENCE_PROXY_SOCK` (`/run/hatch/proxy/inference.sock`), which the cell cannot reach, so model choice is a server-side decision. [T, interp] `avocado` is presumably the codename of Muse Spark 1.3.
- **Inference runs off the box; the harness runs on the box.** Small models do run on the box: ASR (`faster-whisper-tiny`), the 91 MB MiniLM embedder and the 153 MB jina reranker, and some safety classifiers via `ort`.
- **Loop stages** (from symbol names):
  `admission -> pre_inference (skill_loading, prompt_assembly, context_pressure, compaction) -> model stream (ipnext | anthropic /v1/messages | openai responses) -> tool_dispatch_batch (+ approval_intent) -> post_tool_continuation -> post_inference_terminalization`.
  Symbol counts: `agent_loop` 49, `message_execution` 210, `objective_worker` 258, `subagent_spawns` 248, `compaction` 152.
- **Compaction is eager and in the background** (`started_eager_background_compaction`, `adopted_eager_background_compaction`) so the summary is ready before the window fills; it uses its own model (`avocado-memory-flush-v1`).
- **Objective workers** are long-running goals with their own dispatch and "notification steps"; they power the proactive feed editions.
- **Sub-agents are first-class:** `subagent_spawns`, `subagent_monitor`, a `SUBAGENTS_MONITORING.md` policy file in home, per-sub-agent transcripts at `agents/agent-<uuid>/sessions/<uuid>.jsonl` (18 on the author's VM). A dedicated browser sub-agent drives the browser (section 4.4).
- **Per-stage timeouts as env:** `JARVIS_TOOL_DISPATCH_TIMEOUT_MS`, `JARVIS_MODEL_STREAM_FIRST_CHUNK_TIMEOUT_MS`, `JARVIS_POST_INFERENCE_TERMINALIZATION_TIMEOUT_MS` and others; a **restart checkpoint in Postgres** per stage lets a session survive VM replacement mid-turn.
- **Workspace files** (OpenClaw-style) in `/home/hatch`: `AGENTS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `MEMORY.md`, `PROACTIVE_PREFERENCES.md`, `SOUL.md`, `SUBAGENTS_MONITORING.md`, `TOOLS.md`, `USER.md`, `runtime.lock`, and directories `agents`, `assets`, `channels`, `config`, `data`, `docs`, `dreams`, `hooks`, `memory`, `prompts`, `subscriptions`, `user`, `workspace`.
- **No explicit planner/executor pair was seen.** Roles visible: the main agent loop, objective workers (goals), sub-agents (including the browser sub-agent), a compaction/memory-flush model, a classifier ensemble, and Sentinel as a separate policy agent [T][M-SEC]. [INF] the split is "one generalist loop plus specialised workers plus deterministic gates", not plan-then-execute.

### 3.2 Meta states [META]

- Muse runs in the background, launches swarms of sub-agents, builds its own tools and edits itself [M-SEC].
- The model was trained for zero-shot tool calling through CLIs and skills, long context, long-trajectory instruction following with awareness of prompt injection, and multi-agent coordination [M-SEC]. Headline model at launch: Muse Spark 1.3 [M-SEC]; Muse Wonder (2026-10-12) "will power experiences in Muse", subscribers first [M-WON].
- **Active Memory** and **Active Focus** are named model capabilities, not harness components: Active Memory carries important context about the user across conversations and actively retrieves what is relevant to the current task; Active Focus keeps working toward a hard goal by trying alternatives, working through blockers, adapting, asking for clarification when needed and checking in before important actions. Evaluated with FocusBench and SWE-Marathon [M-WON].
- One long main chat (interruptible, several tasks at once, not turn-by-turn) plus side chats for separate context [M-DES]. The first line of the system prompt is about making the user's life better [M-DES].

### 3.3 Third parties [3P/PRESS]

- Exported files include hard-coded components for "managing runaway agent spawning" and for subscription cancellation [CB, relaying The Verge].
- Vellum claims Muse cannot use other model vendors [VEL]; the teardown shows Claude and GPT model strings in the binary [T], so routing is Meta's choice, not the user's.

## 4. Tool surface, connectors, MCP, permissions

### 4.1 Observed [OBS, T][HN1]

- **Tools are CLIs, not MCP servers.** About 70 binaries in `/opt/hatch/bin`, most symlinks to one `hatch-multicall` that refuses to run under its own name. Names seen include `authdc`, `browser-broker`, `browser-service`, `calendly`, `device-data`, `duffel`, `facebook-cli`, `hatch-vault`, `hatch-ws-client`, `hatch-zeitgeist`, `healthkit-cli`, `instagram-cli`, `outlook-mail`, `peloton`, `philips-hue`, `places`, `plaid`, `printify`, `spotify-api`, `stripe-link`, `tailscale`, `tessie-api`, `threads-cli`, `ticketmaster`, `tts`.
- **Privsep per tool.** `spawnd ensure-worker-accounts` creates a `hatch-w-<tool>` uid per tool with an id-mapped view of its state directory; the cell reaches each only through `/run/hatch/privsep/<tool>.sock` (60 sockets).
- **Skill visibility is gated by CD channel, fail-closed.** `/opt/hatch/runtime-cell/skill-scopes.conf` (generated from `extensions_scoped.toml`) lists, per channel (`hatch-e2e`, `internal-test`, `prod`), which gated skill directories to reveal (for example `prod whatsapp`; `internal-test ... polymarket price-tracker ...`; `ads_mcp` appears in test channels). Gated skills live host-side in `/opt/hatch/skills-scoped/`, are overlaid into `/opt/hatch/skills` at cell launch by `launch-daemon.sh`, and an unset or unknown channel reveals nothing [T][HN1]. Tool schemas were not visible.
- **Approval plumbing:** `approval_intent` is part of the tool dispatch stage; HITL approvals flow through Sentinel sockets (`egress-approvals-admin.sock`, `daemon-egress-approvals.sock`) [T].

### 4.2 Meta states [META]

- **Built-in connectors** were integrated with each provider and ship with SKILL instruction files [M-SEC]. Built-in connector CLIs in the cell only parse arguments, open files the caller may already access, and pass typed arguments and file descriptors over a Unix socket; a systemd-sandboxed worker runs the business logic. Workers are identified by cgroup and have explicit credential allowlists, so a calendar worker cannot ask authd for an email credential by changing a parameter. Division of labour: privsep decides where credential-capable code runs, authd decides which credential an authenticated caller may receive, Sentinel decides whether the action may happen [M-SEC].
- Meta's reasoning: CLI connectors running beside the harness can be rewritten by a prompt-injected agent to misuse their credentials, so built-in connector logic runs outside the cell [M-SEC].
- **Connector action flow:** the connector tool runs in the cell and submits to Sentinel the connector, method, class of action, scope and the context of what the user asked; Sentinel derives a user-visible purpose, evaluates the user-set connector policy, and returns allow, deny or ask [M-SEC].
- **Least privilege beyond OAuth scopes:** read and write are separated where the service allows; finer action-level controls exist (for example, removing Gmail settings access that rides along with the read scope); controls at connector, process, credential and request level [M-SEC].
- **Email connector** filters one-time passcodes, password-reset links and magic login links with deterministic filters plus a classifier, so the agent cannot be coerced into taking over other accounts [M-SEC].
- **Custom connectors:** Muse can write its own connectors for services with APIs or CLIs [M-SEC]. The Help Center says you ask Muse to create one, keys go into its Secure Credentials Store, and Meta does not review custom connectors [M-HC1].
- **Defaults:** by default Muse will not take many important actions, such as sending an email, without approval; when it asks is adjustable in Settings; many connectors can be limited to reading; some connectors push updates to Muse proactively and are flagged before you connect; disconnecting stops exchange but prior data may remain in memory and history [M-HC1]. The design team says the default allows standard browsing and stops for anything hard to undo, with controls to be more or less cautious, explicitly to avoid banner blindness [M-DES].
- **MCP is not mentioned** in any Meta post or help article I read [M-SEC][M-NEWS][M-HC1].

### 4.3 MCP in practice [3P]

- **No MCP setting exists in the consumer app.** Asked to connect an MCP server, Muse said it has no one-click integration, asked two questions (HTTP URL or stdio command; what auth), wrote a client with the official MCP SDK over Streamable HTTP, listed and exercised every tool, and saved the integration as a reusable skill. It took one message and under a minute. Remote servers work; a server on the user's laptop is unreachable from Meta's cloud; stdio servers must be installable on the VM [PAR]. Hindsight confirms: Meta's docs do not mention MCP; Muse builds the client itself over Streamable HTTP with OAuth 2.1 discovery and dynamic client registration; remote endpoints only [HS].
- **The "every MCP call stops for approval" default** comes from Hindsight's hands-on: by default every call stopped for approval; setup took six separate prompts of the form "Allow <agent name> to share information with api.hindsight.vectorize.io?", each naming the operation; choosing "Always allow this site" stops them [HS]. [INF] this is Sentinel's egress HITL keyed by destination host (section 2.1), not an MCP-aware rule: custom-connector traffic is just egress from the cell, so the grant granularity is the site. Parallel says approval scopes for custom connectors can be one action, one task, a time window or permanent, and that Settings can hold a connector read-only, require approval for every action, or allow it [PAR]; CData's guides say to approve the tool call in the Sentinel dialog [search snippet only, not fetched].
- **Custom connector code runs inside the runtime cell** without the extra privsep built-in connectors get; Sentinel egress and surrogate-token swapping still apply [PAR].
- Credentials for custom connectors should go through the secure credential prompt, not chat; pasted keys defeat surrogation and stay in history [PAR].
- Zapier became a named connector via Zapier MCP (Streamable HTTP), exposing only the apps and actions the user approves on Zapier's side [ZAP].
- Hindsight's integration is purely prompt-driven because Muse has no hooks or plugin host: the connect prompt tells the agent when to `recall` and `retain`, forbids destructive tools (`delete_bank`, `clear_memories`, `invalidate_memory`), says returned memories are facts not instructions, and sets up a nightly 11pm scheduled task to retain a summary of the day [HS-CP]. When the account had no credits Muse reported exactly which steps failed instead of inventing results [HS].
- For contrast, **Muse Code** (Meta's coding CLI, a different product) documents MCP over stdio or `streamable_http`, warns that MCP tools bypass its sandbox, has approval modes plus "staged shell review", four observer agents enabled by default that propose but do not execute (verification, memory recall, skill recommendation, goal tracking), up to eight concurrent sub-agents by default (`agents.execution_capacity` 1 to 64), and hooks that run outside the sandbox [INN, third-party summary of Meta docs, not verified].

### 4.4 Browser [OBS + META]

- [OBS, T] `browser-broker` routes sessions to leased "VMVM" browser VMs built from an immutable image; inside, the browser is a Docker container behind a broker-private Docker API socket; leases last 15 minutes and are obtained through the Stefi control-plane proxy. The cell has no path to the broker by design (help text: to close a HITL-consent bypass); only the daemon, admitted by exact cgroup identity and peer uid, can reach it. `/opt/meta-chromium` ships in-cell for cookieless headless work. Classifiers `visual_browser_screenshot_guard` and `browser_action_guard` watch it.
- [META, M-SEC] A real Chromium behind a virtualization layer; users can watch and take over at any time; a separate broker owns the CDP connection; a browser sub-agent sees an accessibility-tree snapshot, not the DOM (so it cannot read credential-store fills); no page JS, no script verbs, no exec in the browser process, DevTools disabled; the agent is paused during user takeover and while credentials are being filled. Website passwords are captured by a custom client UI, sent straight to authd and injected at the point of need. Five browser classifier families: personal-data egress unrelated to the task, injection in the DOM, injection in images/media, injection in downloaded files, high-risk form submission. Meta's malicious-site lists are matched inside the VM.

## 5. Memory

### 5.1 Observed [OBS, T]

- **Source of truth is Markdown** under `~/memory/`: dated logs, `bank/{world,experience,opinions}.md`, plus people and group pages. Top-level `MEMORY.md`, `USER.md`, `SOUL.md`, `IDENTITY.md` and a `dreams/` directory sit in home.
- **Postgres is the index**, a real server per VM (binary `/opt/metasql` on the VM root, data dir `/var/lib/hatch/postgres` on the LUKS RV, mode 000 to the cell, socket `/run/hatch/postgres/.s.PGSQL.5432`, pooled client with `postgres/write_retry.rs`). Every chunk lands in `memory.entries` with a `path#L<line>` citation, as a 384-dim pgvector row in `memory.embeddings` (model `Qdrant/all-MiniLM-L6-v2-onnx`, 91 MB, on the box) and as a tsvector. Other memory tables: `memory.claims`, `memory.entry_attributes`, `memory.embedding_models`, `memory.metadata`.
- **Retrieval is hybrid** (vector plus keyword) reranked by `jinaai/jina-reranker-v1-turbo-en` (153 MB), run by both the `memory_search` tool and the pre-inference recall step. [T, interp] the embedder is local because the corpus is the most personal data on the box and is re-embedded every time a memory flush appends to it.
- **Memory flush** uses its own model `avocado-memory-flush-v1` (shared with compaction).
- **Schema:** 194 tables documented in a 4,116-line `muse_db/references/schema.md`; groups `activity agent device feed goals health ideas ingest media memory messages podcasts runtime scheduler self_improvement shell spaces`. `device.*` is the phone synced in (contacts, call log, calendar, uploads); `agent.*` holds transcripts, compactions and sub-agent progress; reasoning columns are served through a redacted projection.
- **Agent access to the DB** is a `muse_db` skill exposing a bounded read-only `SELECT` surface. DB credentials come only from authd to trusted callers (checked by `SO_PEERCRED` uid and cgroup); a diagnostic tool run from the user shell got 403.
- Backups via btrfs snapshots. The only git repo on the box was the author's own: memory is not git-versioned (contrast Instinct, which keeps a Markdown vault in git [T0]).

### 5.2 Meta states [META]

- Muse remembers what matters and learns from conversations; users can tell it to forget specific things [M-NEWS].
- Memory files can be read and edited directly in the app [M-DES]. Help Center paths: Assistant icon > Identity > Memory edits or deletes entries in `Memory.md`; Identity > Soul or Identity edits or clears `Soul.md` and `Identity.md`; a "forget" skill is invoked in chat; Settings > Data controls offers Download your Muse data and an irreversible Reset Muse [M-HC2].
- Users can inspect, edit and download all VM files including Muse's memory about them [M-SEC].
- Active Memory is a model capability (section 3.2) [M-WON]; Meta has not described its mechanism.

### 5.3 Reported [PRESS]

- **Hourly dossiers.** From Muse's internal instructions, TIME reports that each hour Muse updates its pages on the user and on people mentioned in chats, messages and emails it has read, recording how people met, shared interests, disputes and social "tensions and alliances"; it is designed to infer goals the user has not said aloud and records which nudges work (example in a prompt: the user responds better to short nudges after 10 PM); agents run a nightly analysis of the day's conversations [TIME]. WIRED (via LDS) describes "an hourly process that can build and update pages about people", pages that "begin sparse and develop over time", with categories such as facts, relationship history, shared context and open threads [LDS]. A search-engine summary of WIRED named sections Facts, History, The Relationship, In Common, Open Threads, Strengthening; I could not verify that list.
- **Cross-VM learning.** Instructions say agents across VMs teach each other through shared lessons after scrubbing names; Meta says learnings are de-identified and improve the product rather than being shared directly between VMs [TIME].
- **Forget is not erase.** Forgetting does not necessarily remove the original message, and the instructions tell the agent not to say so [TIME].
- **Persona.** Instructions say Muse is not a chatbot and is "becoming someone"; in voice mode it must not call itself AI [TIME].
- Exported files show plain Markdown memory documents and a nightly review of recent conversations that generates guidance for future interactions [CB].
- Meta's David Singleton said Meta wants users to see the Markdown files Muse writes [TIME].

## 6. Proactivity, schedules, goals

### 6.1 Observed [OBS, T]

- `workspace/cron.d/{secondly,minutely,hourly,daily,weekly,monthly,yearly,runonce}`; a cron store with its own control socket (`/run/hatch/cron-store/control.sock`) and a `scheduler` schema in Postgres.
- `workspace/goals/<slug>/{GOAL.md,briefs,crons,agent_notes,files,references}`: each long-term goal is a folder with its own crons and notes.
- `workspace/feed/` and the `feed` schema: a daily "edition". `PROACTIVE_PREFERENCES.md` in home says Muse reads the whole file before composing the day's edition.
- Objective workers with notification steps power the feed (section 3.1). `HEARTBEAT.md` and a `subscriptions/` directory exist (contents not shown). `ideas` is a Postgres schema group.

### 6.2 Meta states [META]

- Once a goal or task is set, Muse keeps working on a schedule and in response to relevant events; after background work it evaluates whether the result is worth surfacing and notifies only when something is meaningfully new or needs input [M-DES].
- It can message unprompted, so the bar is set high; users can turn proactivity off, down or up [M-DES]. It can act on details mentioned only once and returns when something changes or approval is needed [M-NEWS].
- A Goals tab shows long-running goals and Muse's plans; an Ideas tab and onboarding tips surface suggestions generated from goals, patterns and conversation; an "Upcoming" view lists reminders and scheduled tasks, editable in chat [M-DES][M-HC2].

### 6.3 Reported failures [PRESS]

- A dogfooder asked Muse to monitor fast-selling tickets; the page stopped refreshing after about 15 minutes, other errors went unnoticed and monitoring switched off with no explanation [IMP, relaying Reuters].
- Within a day of setup Muse pitched article ideas based on a user's private texts; asked how it knew, it said it read notification banners, which was false; the user found it had synced 187,000 lines of his Messages database with macOS Full Disk Access off (Jason Aten in Inc, as quoted in [HN2]; commenters dispute the mechanism, and Meta says Muse obeys user permissions).

## 7. Safety

### 7.1 Layers [META unless marked]

1. **Model training** to resist injection; Muse Spark 1.3 "close to SOTA" on Meta's own evals [M-SEC].
2. **Harness labelling:** any external data entering context is labelled untrusted input [M-SEC]. [OBS, T] an "ORIGIN GATE" prompt classifies which text sources could carry an injection, and `JARVIS_EXTERNAL_CONTENT_BOUNDARIES_ENABLED` toggles external-content boundaries.
3. **Classifier ensemble**, trained independently of the model, run in parallel on all external data entering context via files and tool calls, outside the cell so the agent cannot disable it [M-SEC]. [OBS, T] named models `9b_safety_classifier`, `2b_tool_call_classifier_v0_4`, `pi_3b_prefilter` (injection prefilter), `cbrne_returned_text_guard`, `policyguard`, `phone_call_judge`, `visual_browser_screenshot_guard`, `browser_action_guard`; string counts judge 198, guard 75, classifier 70, gatekeeper 45; some run on-box via `ort`, others behind `/run/hatch/safety/security.sock`.
4. **HITL approvals** for actions that move data out of the VM [M-SEC] (section 4.2).
5. **Deterministic floors** that hold even if the model is persuaded: the cell, privsep, authd ACLs, Sentinel on every action and all egress [M-SEC]; eBPF connect gate under Sentinel [T].
6. **Tainted egress** (section 0, item 5) [M-SEC].
7. **Egress inspection** at L4 and L7: hostname, resolved and final IP, port, protocol, HTTP method, path and decoded request; SSRF checks stop public names resolving to private infrastructure [M-SEC].
8. **Lethal trifecta framing** (private data, untrusted content, external communication) cited explicitly as the design driver [M-SEC].

### 7.2 Action risk classes

- Sentinel receives a "class of action" and scope with each connector request [M-SEC], but **no taxonomy is published**. What is published is behavioural: read-only, previously allowed or demonstrably low-risk actions proceed without interruption [M-SEC]; standard browsing is allowed, anything hard to undo stops [M-DES]; sending email and purchases always check in [M-NEWS][M-HC1]; purchases prompt every time with exact details [M-SEC].
- [INF] Effective classes: read; low-risk/reversible; external send; irreversible; money. Weft's existing `effect` field (read, draft, write, external) plus "money" maps onto this.

### 7.3 Spending

- Checkout pages are detected in the browser and trigger an approval with exact purchase details every time; the wallet (Stripe Link at launch, Shop Pay later) issues a single-use card number tied to one merchant, one amount and a short validity window [M-SEC]. Muse is covered by Link purchase protections [M-NEWS].
- [OBS, T] `checkout-spend.sock`, `stripe-link-checkout-card` privsep worker, and a `credit-watcher.sock` (credit meter).
- **No numeric spending limits are published** [M-SEC][M-NEWS]. Pricing: free tier plus Power ($20/month) and Maximum ($100/month), card required even for free [PAR, not confirmed by Meta].

### 7.4 Offline self-improvement [OBS, T]

An `/alignment/system/steps/` pipeline (`judge`, `reflect`, `repair`, `distill`, `generalize`) and a `self_improvement` Postgres schema grade and rewrite the agent's behaviour offline. `JARVIS_DEFAULT_MAX_TRAINING_TIER` [T, interp] looks like a per-user consent level for training use.

### 7.5 Assurance

Dogfooding since early 2026, agentic red teaming that also produced an offline eval set, a private then public bug bounty up to $300,000 (up to $130,000 for a prompt injection affecting one user) [M-SEC]. Launch was delayed from April for security work [IMP].

## 8. Privacy controls [META unless marked]

- Users choose which apps connect and how much access each gets, and can change or disconnect at any time [M-NEWS]. Read and write split per connector [M-SEC].
- Conversations and VM data are not shared with Meta ad systems, though agent browsing appears as the user's own activity and can indirectly shape ads [M-SEC].
- Training: trajectories (conversations, tool calls, sub-agent handoffs) are sanitized of key PII and used for training by default; opt out via Settings > Data controls, on by default [M-SEC][M-HC2].
- Export, reset, delete: section 5.2 [M-HC2].
- Credentials and OAuth tokens are stored in the user's VM, not central infrastructure [M-SEC].
- [PRESS] Reported gaps: dossiers on non-users, cross-VM lessons, forget not erasing, a related "Muse doxxing" report from Hunterbrook (https://hntrbrk.com/breaking-news/muse-doxxing, not read) [TIME][HN2].
- [PRESS] Users could get Muse to export archives of its own system files, templates and internal docs with little prompting; Meta says this is intentional user access, not a breach, and that it is revising how much internal information is exposed [CB].

## 9. Observability

- [META] Tapping the avatar shows a snippet of current work, the full activity log and the permissions you have approved [M-DES]; Meta promises "a complete audit trail" of what Muse has done and plans to do [M-NEWS].
- [OBS, T] Telemetry socket to Meta logging ("scuba"), a bug-report socket, Prometheus metrics on `daemon/metrics.sock` polled by `hatch-healthd` from the host side. Per-request latency fields: `ingress_ms`, `admission_ms`, `pre_inference_prompt_assembly_*_ms`, `time_to_llm_ms`, `time_to_first_response_token_ms`, `tokens_per_second`. Readiness metrics `hatch_mount_to_ws_ready_*` (`postgresql_startup`, `db_preflight`, `runtime_cell`, `daemon_active_to_ws_ready`, `readiness_bottleneck`). Rollout fields `rollout_id`, `release_id`, `previous_build_id`, `target_build_id`, `outage_duration_ms`, `pre_deploy_all_healthy`. Lifecycle events posted to `/v1/runtime-events` and `/v1/leased-vm-resources-events` with `host_region` and `git_sha`.
- [3P] Zapier MCP keeps its own activity history for actions Muse takes through it [ZAP]: audit is split across systems.

## 10. Failure handling

- [OBS, T] Replace, never reboot; durable state off the VM; rollouts cost about 40 s and lose nothing; stage-level timeouts and Postgres checkpoints resume a turn after replacement; prewarm fails open while skill overlay fails closed; browser leases expire after 15 minutes. `hatch-rescue` offers `restart-component`, `emit-flare` and `emit-codex-session`, which spawns an OpenAI Codex CLI (`codex-cli 0.149.0`, 258 MB) app-server in a rescue home to diagnose a `kernel_incident`: the VM's on-call is an agent.
- [OBS, T] An approval storm is itself a failure mode: unattributed background egress produced a fleet-wide HITL prompt storm on 2026-08-15.
- [META] When an approval is pending, that execution stops until Sentinel gets the user's answer [M-SEC]. Meta's own conclusion: prompt injection is unsolved and Muse will make mistakes, so the design bounds impact [M-SEC].
- [PRESS] Dogfooding: guardrails bypassed to expose iCloud photos while identifying toys in party photos; the CTO logged out repeatedly; monitoring silently stopped after about 15 minutes [IMP]. Provenance misreported to the user (section 6.3) [HN2].
- [3P] Non-idempotent setup prompts created a duplicate "About me" mental model on each re-run; Hindsight fixed it by checking before creating [HS]. Muse reported partial failure honestly when the memory service returned 402 [HS].

## 11. Sandboxes for Weft: open source and Cloudflare free tier

Nitish asked to look at open-source sandboxes and anything Cloudflare offers on the free tier, given Weft will not serve many users.

**What Muse teaches here.** The safety did not come from the VM brand (Cloud Hypervisor vs Firecracker). It came from (a) the agent having no credentials and no direct path to the database, browser, inference or the network, (b) one broker that every effect passes through, and (c) approvals delivered outside the chat [M-SEC][T]. On a single-user laptop with synthetic data, Weft gets (a) to (c) from process and module boundaries; a VM per user is unnecessary. research/agent.md already concluded the same for Instinct's E2B boxes.

**Does Weft need a code sandbox at all?** [INF] Only if the agent runs code it writes (Muse's custom connectors, `spaces` web apps, compiled tools). Weft P0 exposes typed registry commands only (SPEC 9.2), so no sandbox is needed for P0. If a later track lets the agent write report scripts or custom routine logic, these are the options found:

| Option | Fit for Weft | Cost | Notes |
|---|---|---|---|
| Docker container per run: `--network none`, read-only rootfs, non-root user, `--cap-drop ALL`, default seccomp, bind only an input/output dir | Closest local analogue of Muse's cell; Docker is already on the machine | free | [INF] gives namespaces, seccomp, no capabilities, no network; the executor stays the only path to effects |
| Cloudflare Dynamic Workers (Worker Loader) on workerd | Best match to Muse's broker model: `globalOutbound: null` makes any `fetch()`/`connect()` throw, and capabilities are passed only as bindings; or a `WorkerEntrypoint` gateway intercepts every request and injects credentials so the sandbox never sees the secret [CF-DW] | **Workers Paid only** on Cloudflare: "currently only available on the Workers Paid plan"; 1,000 unique Dynamic Workers/month included then $0.002 per Worker per day [CF-DW] | Limits: 4 concurrent Dynamic Workers per Worker request, 10 per Durable Object [CF-DW]. workerd is open source, but whether `worker_loaders` runs under local `wrangler dev` was **not verified**; test before relying on it. JS/TS only, V8 isolate (Cloudflare itself says isolates are a more complex attack surface than VMs, per a search summary, not verified) |
| Cloudflare Containers / Sandbox SDK | Full Linux sandbox at the edge | **Not on the free plan**: the pricing table shows "N/A" for Free and ties included usage (25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk) to the $5/month Workers Paid plan [CF-CT] | GA since 2026-04-13 per Cloudflare's changelog title (search result, not opened) |
| Cloudflare Workers Free | Hosting a thin public demo or proxy only | free: 100,000 requests/day, 10 ms CPU per invocation [CF-W] | No sandbox product on the free plan (inference from CF-DW and CF-CT) |
| E2B self-hosted | Firecracker microVMs, Apache-2.0, runs on any Linux box with `/dev/kvm`; on a Mac via Colima, per an E2B employee [HN0] | free (self-hosted) | Heavy for a 9-hour laptop build; overkill for synthetic data |

Recommendation [INF]: no sandbox in P0. Keep Muse's boundary as code: the agent package cannot import the DB, simulators or vault (SPEC already enforces with an import-scan test), every effect goes through `executor.exec`, and secrets are vault handles swapped inside the executor. If agent-written code arrives later, start with a locked-down Docker run (free, local, already installed); consider Dynamic Workers only on a Workers Paid account; on the Workers Free plan neither Dynamic Workers nor Containers are available [CF-DW][CF-CT].

## 12. Patterns for Weft: copy, adapt, avoid

SPEC references are to SPEC.md (draft) sections.

### Copy

1. **Sentinel as the executor (SPEC 9.3).** One authority decides allow, deny or ask for every agent and human effect; the agent can only propose. Keep "approvals never block the loop": Muse stops the one execution, not the whole agent [M-SEC]; SPEC's `pending_approval` plus `waiting` matches.
2. **Grants as strict capabilities.** Bind a grant to (command, target or destination, use case) and support Muse's five scopes: one-time, run-scoped (session), task-scoped, time-bounded, perpetual; the executor, not the model, chooses which scopes to offer and checks later calls match exactly [M-SEC]. For P0, one-time and time-bounded are enough; never offer perpetual for `external` money effects.
3. **Purpose text from structured fields.** The proposal card's headline is rendered by the executor from command metadata, args diff, effect class and the user request that started the run; the model's rationale is shown separately and labelled as the agent's explanation [M-SEC].
4. **Out-of-band approval UI.** Decisions happen in the decision inbox with accept and reject buttons, never by the user typing "yes" in chat; approve/deny are human-only and absent from every tool surface (SPEC 9.2 already) [M-SEC][M-DES].
5. **Run taint (tainted egress, deterministic).** Mark registry commands whose output contains untrusted text (`notices.get`, chat simulator reads, email-like inputs). Once a run has read one, it loses any auto-allow for `external` effects and every such call becomes a proposal for that run [M-SEC]. Cheap to build: a boolean on the run, set in the executor.
6. **Untrusted labelling plus origin tags.** Wrap external text in `<untrusted source=...>` (SPEC already wraps notice bodies) and tell the model in the frozen system prompt that such content carries no instructions [M-SEC][T].
7. **Deterministic redaction before the model sees data**, like Muse's email OTP and reset-link filter: masked SSNs, bank and routing numbers, tax IDs in all tool output (SPEC `people.get (masked)`) [M-SEC].
8. **Surrogate credentials.** Agent-visible vault entries are handles; the executor swaps in the secret at the simulator boundary; nothing secret appears in prompts, logs or memory [M-SEC].
9. **Read/write split per namespace** and grants finer than a coarse role, as Muse does beyond OAuth scopes [M-SEC]; Weft's `effect` and `needs` fields already carry this.
10. **Named loop stages with per-stage timeouts and checkpoints** (SPEC 9.5): admission, pre-inference (tool set selection, prompt assembly, context pressure check, memory recall, compaction), model step, tool dispatch batch (with approval intent), post-tool continuation, terminalization. Persist each step so a restarted API process resumes the run. Timeouts as env (`WEFT_TOOL_DISPATCH_TIMEOUT_MS`, `WEFT_MODEL_FIRST_CHUNK_TIMEOUT_MS`) [T].
11. **Instrument every stage** with the same fields Muse logs: `admission_ms`, `prompt_assembly_ms`, `time_to_llm_ms`, `time_to_first_token_ms`, `tokens_per_second`, per run step [T]. The SSE stream already carries steps.
12. **Memory: Markdown source of truth plus a derived, rebuildable index** with `path#L<line>` citations; hybrid keyword plus vector search with a rerank; used both by an automatic pre-inference recall step and an explicit `memory.search` tool [T]. For Weft: SQLite FTS5 first; embeddings optional (a local MiniLM-class model is what Muse uses).
13. **Fail-closed tool scoping**: per routine and per surface allowlists where an unknown surface sees nothing, like `skill-scopes.conf` [T][HN1]. SPEC 9.6 and 9.8 already do this; make the default empty.
14. **"Worth surfacing" gate for routines**: after background work, a deterministic or cheap check decides whether to notify (meaningfully new or needs input) or to only log [M-DES]. Store per-company notification preferences in a file read in full before composing the weekly digest, as `PROACTIVE_PREFERENCES.md` is [T].
15. **Goals as folders** (`GOAL.md`, briefs, crons, notes, references) if Weft adds long-running goals; maps cleanly onto the memory repo's `workstreams/` [T].
16. **Activity log and approved permissions shown together**, one tap from the agent's status [M-DES]; Weft's action log page should list active grants beside actions.
17. **Inference unreachable from tools.** The provider layer is only called by the loop; tool code never gets model credentials [T].
18. **Honest partial-failure reporting** when a dependency fails, step by step, as Muse did with Hindsight's 402 [HS]; add it to the main agent's prompt and to routine run summaries.

### Adapt

1. **VM per user -> module boundaries on one laptop.** Brain/hands split with the import-scan test is Weft's runtime cell; the executor is privsep plus authd plus Sentinel in one module [M-SEC][INF].
2. **Classifier ensemble -> deterministic checks plus an optional judge.** Weft cannot run 2B to 9B classifiers on a 24 GB laptop alongside the model. Use regex and structural injection markers on untrusted inputs, schema validation of tool args, and, only for `external` proposals, an optional cheap LLM judge whose verdict is shown on the card, never used to auto-approve [T][INF].
3. **Hourly dossiers -> event-driven people pages, work facts only.** Refresh an employee's memory page when an HR event touches them, not on a timer; record work-relevant facts with sources; no relationship maps, persuasion notes or inferred unstated goals [TIME][INF].
4. **Eager background compaction -> summarise at a token threshold before the limit**, with a cheap model or deterministic summary of tool results; with gpt-5.6-luna as default, compaction can use the same model at low effort [T][INF].
5. **Proactive daily edition -> the weekly people digest routine** (SPEC 9.7 `rt_people_digest`), with the worth-surfacing gate and a dial (off, low, normal) in settings [M-DES].
6. **Offline judge/reflect/repair pipeline -> a dev-time eval loop** using the scripted provider and a handful of graded transcripts; not a runtime feature [T].
7. **Rescue agent -> a "doctor" command** that collects run, scheduler and provider health into one report; no autonomous self-repair [T][INF].
8. **Channel-gated skills -> feature flags per environment** (`dev`, `test`, `demo`) that hide unfinished tools, fail-closed [T].

### Avoid

1. **Site-level "Always allow" as the only grant granularity.** It produced six prompts to set up one memory service and then a blanket permanent allow [HS]. Grants should be per command and target with expiry.
2. **Approval storms.** Unattributed or background effects must never generate prompts; Muse had a fleet-wide storm from apt timers [T]. In Weft, scheduler and simulator activity runs as system principals with explicit policies.
3. **Trusting the agent's account of its own provenance.** Muse reportedly told a user it read notification banners when it had synced his Messages database [HN2]. "How do you know this?" must be answered from the action log and memory citations, not from the model's self-report.
4. **Forget that does not forget, and hiding it** [TIME]. Weft's memory is a git repo, so a forget must delete the note, purge the index and tell the user plainly that git history still holds it unless history is rewritten.
5. **Persuasion profiling and cross-tenant "shared lessons"** [TIME]. Never in an HR product.
6. **Persona prompts** that tell the agent it is "becoming someone" or must not call itself AI [TIME]. Weft's agent should say plainly it is software.
7. **Agent-authored integrations that hold credentials inside the agent's domain.** Muse's custom connectors run inside the cell without privsep and are unreviewed [PAR][M-HC1]. Weft's agent may draft routines but cannot create commands or call new hosts.
8. **Silent stops in long-running monitoring** [IMP]. Every routine run ends in a terminal state with a reason; the scheduler flags a routine that has not produced a run when due.
9. **Non-idempotent setup** [HS]. Keep SPEC's run keys and make every create command check-then-create.
10. **Over-broad default data ingestion** (device sync of contacts, call logs, messages) [T][HN2]. Weft reads only the fictional company's records it needs.

## 13. Open questions for the harness architect

1. Which grant scopes ship in P0: one-time plus time-bounded only, or also run-scoped? (Recommendation: one-time and time-bounded; run-scoped if cheap.)
2. Is run taint (Copy 5) in P0? It is about 30 lines in the executor and closes the obvious notice-injection path for `external` effects.
3. Should Weft's own MCP server (SPEC 9.8) mark every MCP-originated call as tainted by default, since the caller's context is unknown? Muse's experience suggests treating external agents like untrusted content.
4. Does memory recall run automatically before every model step (Muse's pre-inference recall) or only as a tool? Automatic recall costs tokens on every step; with luna pricing it is cheap, with the local 27B it is slow.
5. Should proposal cards show an optional judge verdict (Adapt 2), and which model runs it given the $0.50 per-agent live budget?
6. Is a code sandbox ever in scope for this build? If not, record "no agent-written code execution" as an ADR so later tracks do not add it casually.
7. Discrepancy to note, not resolve: Meta says the cell runs a Debian image [M-SEC]; the teardown saw an Ubuntu kernel and apt manifest [T]. Irrelevant to Weft but a reminder that company prose and observed systems differ, so Weft's own docs should be generated from code where possible.
