# Instinct, in depth: how its harness is built, and what Weft takes

Research for the Weft harness architect, written 2026-10-15 (13:47 to 14:15 PDT). Goes deeper than `research/agent.md` section 2, which it extends and in places corrects. Every fact carries a source tag. Evidence classes:

- **[OBS]** observed directly by someone inside or probing the system (a teardown, a probe transcript, a commit hash).
- **[CO]** stated by Instinct or its founder (site, terms, privacy policy, founder posts, founder interviews).
- **[3P]** reported or inferred by a third party (journalists, competitors, commenters). Weaker; marked when it is inference.
- **[WEFT]** a proposal for Weft, not a fact about Instinct.

Caveat on wording: pages were read through a summarizing fetcher (WebFetch), so short quotes below are close paraphrases unless marked as verbatim; the two founder X posts were fetched raw (via the public `api.fxtwitter.com` mirror) and are quoted verbatim. Re-fetch before quoting anything in user-facing copy (Weft should not quote Instinct in UI anyway).

Legal note: Instinct's Terms forbid reverse engineering "any underlying idea or algorithm" and benchmarking [TERMS]. Weft uses only published write-ups; nobody on this project should probe Instinct. Weft code, UI and docs should not name Instinct; credit public write-ups generically in NOTICE, as StaySignal does (`~/Developer/projects/staysignal/NOTICE`).

## Sources

| Tag | Source | Class | Notes |
|---|---|---|---|
| [INST] | https://rohanadwankar.github.io/posts/platforms ("The box an agent runs in", Rohan Adwankar) | OBS | Shell inside the sandbox via a websocket terminal (tool: https://github.com/RohanAdwankar/ws-term). The only teardown of the box. Post undated; HN thread was 37 days old on 2026-10-15, so about 2026-09-08 |
| [INST-HN] | https://news.ycombinator.com/item?id=49605644 ("The VMs Powering Mobile Agents (Instinct, Claude Code)") | 3P | Author's caveat: "if they are doing something else behind the api i wouldnt be able to see it". E2B staff (ushakov, mlejva) comment. No Instinct staff comment |
| [AGENT] | `~/Developer/projects/weft/research/agent.md` section 2 | | Prior reading of [INST]; holds the help-text strings quoted below |
| [SM] | https://supermemory.ai/blog/reverse-engineering-instinct-memory/ (raw: `.md` suffix), Dhravya Shah, 2026-09-20 | OBS + INF, competitor | Black-box probing over iMessage only; the agent reported paths, commit hashes and file contents. Author: "Most of it should be correct". Supermemory sells a competing memory product |
| [SITE] | https://instinct.com | CO | Marketing only: text or call it; "can use a phone and computer in the same way that you do". No docs, blog, changelog or careers page linked |
| [PRIV] | https://instinct.com/privacy-policy (last revised 2026-08-26) | CO | Spear Street Technology, Inc. d/b/a Instinct |
| [TERMS] | https://instinct.com/terms (last revised 2026-08-26) | CO | |
| [X-1P] | https://x.com/noahrshinn/status/2095911123291881608 (2026-09-04) | CO, verbatim | Vault and 1Password partnership |
| [X-TOTP] | https://x.com/noahrshinn/status/2098466184912089143 (2026-09-11) | CO, verbatim | Authenticator (TOTP) support |
| [TC-GROUP] | https://techcrunch.com/2026/10/05/instinct-brings-its-ai-agent-to-group-chats-even-for-friends-without-an-account/ (Sarah Perez) | CO quoted by 3P | Group chats, permission model |
| [ILTB] | Invest Like the Best EP.493, 2026-09-28, https://podcasts.apple.com/bh/podcast/noah-shinn-building-instinct-the-personal-agent/id1154105909?i=1000792019848 | CO | Not listened to; read through the three summaries below |
| [PA] | https://podcastalpha.substack.com/p/noah-shinn-on-instincts-10-a-day (2026-09-28) | CO via 3P summary, timestamped | |
| [36KR] | https://eu.36kr.com/en/p/4003952149663618 (2026-09-29) | CO via 3P excerpt | |
| [ZF] | https://www.woshipm.com/ai/6472662.html (Z Finance, 2026-09-30, Chinese) | CO via 3P translation | Most technical founder statements: inference pipeline, firewall, action monitor |
| [VEL] | https://www.vellum.ai/blog/official-instinct-breakdown (Nicolas Zeeb, dated 2026-08-20) | 3P, competitor marketing | Second-hand incident reports; investor Anish Acharya's description |
| [DIGG-LOGIN] | https://digg.com/tech/8c370261-cff6-4db0-88f8-3442aabfac1a, featuring https://x.com/ronithhh/status/2094574949826691219 (2026-08-31) | 3P aggregator | Phone-webview login; poster's affiliation not verified |
| [TC-SEC] | TechCrunch 2026-08-24 report, read only via secondaries: https://aiunderstanding.org/news/techcrunch-reports-privacy-and-security-concerns-around-instinct-ai-assistant and https://vibegraveyard.ai/story/instinct-ai-agent-unapproved-email-data-retention/ | 3P | Search snippets only; original not fetched |
| [EXPLX] | https://explainx.ai/blog/instinct-1password-ai-agent-account-vaults-2026 | 3P | Mostly speculation about the 1Password mechanism |
| [REFLEXION] | Shinn et al., "Reflexion: Language Agents with Verbal Reinforcement Learning", NeurIPS 2023, https://arxiv.org/abs/2303.11366 | founder's prior research | No source ties it to Instinct's design |

Searched and found nothing: an Instinct engineering blog, docs, changelog, public job listings that reveal the stack (searches for "Spear Street Technology" careers returned an unrelated "Spear AI"), talks by Instinct engineers, and any public source for the `instinct-prod-observations` contents. A different open-source "Instinct" (an MCP memory server for coding agents, SQLite at `~/.instinct/instinct.db`) is unrelated.

## 1. The whole system on one screen

Reconstructed from [INST], [SM], [ZF], [36KR]. Solid lines are observed; the rest is company-stated or inferred, as tagged.

```
 user channels: iMessage / SMS / WhatsApp / phone call / email (own number, own mailbox) [CO SITE, 36KR, ZF]
        |
        v
 SERVER (api.instinct.com)                                            [OBS INST: endpoint; rest CO/INF]
   content firewall on all external input (email, web pages)          [CO ZF]
   main agent  <-- context pack: identity profile, memory one-pager,   [OBS SM]
     |             compaction recap, todo board, session id (~10k tok)
     |-- spawns task agents (focused job, report back, hold)          [OBS INST help text]
     |-- decoupled action monitor audits every intended action:        [CO ZF, PA]
     |     allow / block / hold / require user confirmation
     |-- tool-execute endpoint (GraphQL) holds integrations, vault,    [OBS INST]
     |     cloud browser pool, payments
   own inference pipeline: distilled/pruned models, background work   [CO ZF, PA]
     batched asynchronously on idle clusters
   daily memory consolidation job ("reconciliation")                  [OBS SM latency; INF schedule]
   S3: instinct-prod-agent-memory (one git bundle per user)           [OBS INST]
       instinct-prod-observations (raw firehose)                      [OBS INST, not opened]
        ^
        | tool calls leave the box as requests; bash comes in as requests
 BOX: E2B Firecracker microVM, Ubuntu 22.04.5, 2 vCPU, 1.9 GB, 29 GB, XFCE, uid 1001 [OBS INST]
   agent-exec-server (Go, :8080) runs bash/code the backend sends    [OBS INST]
   `tools` CLI -> Rust daemon on /tmp/.tools/bridge.sock -> --base-url GraphQL [OBS INST]
   /memory git repo (Markdown, wiki-links, grep)                      [OBS INST]
   /etc/instinct-aws-creds: short-lived STS keys for the memory bucket only [OBS INST]
   no model, no provider strings in binaries                          [OBS INST]
 CLOUD BROWSER POOL (separate from the box): Chrome with the user's saved profile, leased [OBS INST]
```

## 2. Memory repository

### 2.1 Location, identity, sync

- `/memory` in the box is a git repo of Markdown with `[[wiki-links]]`, navigated with `grep`; `README.md` starts "Persistent memory for" followed by a wiki-link to the user [OBS INST].
- Git author is "Instinct Agent" `<agent@instinct.com>`; there is no memory API, the agent writes Markdown and commits [OBS INST].
- Durable copy: S3 bucket `instinct-prod-agent-memory`, keyed by a per-user id, stored as a single git bundle, so a bucket listing looks nearly empty [OBS INST]. Credentials are short-lived STS keys (ASIA prefix plus session token) scoped to a role, at `/etc/instinct-aws-creds`; a leaked box loses access at expiry [OBS INST]. Inference [WEFT reading]: the box is disposable; on boot it pulls the bundle, on change it pushes a new bundle. The box never holds integration credentials, only this narrowly scoped memory credential.
- Old versions stay in git history and dated notes; the model must look for them explicitly [OBS SM].

### 2.2 Folder layout (union of both observations)

| Path | Seen by | Content |
|---|---|---|
| `README.md` | INST | "Persistent memory for [[user]]"; per [SM], the README also names timeline tiers `raw`, `hourly`, `monthly` that were absent in the copy the agent could reach |
| `entities/people/` | INST, SM | One file per person; durable properties and relationships |
| `entities/projects/` | INST | One file per project |
| `entities/orgs/` | SM | Organizations |
| `comms/chat/`, `comms/email/`, `comms/meetings/` | INST (chat seen; email and meetings in layout notes) | One file per conversation, named `<who>--<topic>--<date>.md` |
| `comms/phone/` | SM | Conversation digests |
| `timeline/raw/`, `timeline/hourly/`, `timeline/daily/`, `timeline/weekly/`, `timeline/monthly/` | INST (daily seen, tiers in notes); SM (daily and weekly seen) | Events, coarsened over time |
| `workstreams/active/`, `workstreams/completed/`, `workstreams/someday/` | INST (all three), SM (active, completed) | Ongoing jobs; frontmatter `status:` equals the folder |
| `knowledge/facts/`, `knowledge/decisions/`, `knowledge/procedures/`, `knowledge/preferences/` | INST (all four), SM (no procedures) | Durable knowledge, current state |
| `knowledge/preferences/instinct/` | INST | How the user wants the assistant to behave: `autonomy.md`, `iteration-style.md` (both seen) |

Discrepancies: [SM] saw no `procedures/` and no `instinct/` folder and reports "procedural/skill memory: not present" [OBS SM]. [INST] saw both. Likely per-user variation (folders created lazily) or [SM]'s view was partial; [SM] says the accessible copy was incomplete.

### 2.3 File format

- Frontmatter on every file: `id`, `type`, `aliases` [OBS INST, SM]. Verbatim example from [SM]:
  ```yaml
  id: dining
  type: preference
  aliases: [food, lunch, restaurants, takeout, delivery, dining]
  ```
  Types seen: `preference`, `person`, `organization`, `conversation` [OBS SM]. Workstreams also carry `status` [OBS INST].
- Body: headings, then prose and bullets; facts are dated bullets in the style "stated on 2026-09-15" [OBS SM]. Dates on every claim let the model judge staleness; [SM] notes the derived profile also carries dates for that reason.
- `[[id]]` resolves to `id.md` or `id/_index.md` [OBS INST]. A file that outgrows one page is promoted to a directory with `_index.md` that keeps the original id, so links never break [OBS INST].
- Links are dense and graph-like; redundant and duplicate statements exist, which [SM] guesses helps grep recall [OBS SM, INF].

### 2.4 Facts versus events

- Entity and knowledge files are current state, updated in place, never a log; timeline and comms hold events and conversations; entities hold only durable properties [OBS INST].
- The split is enforced at consolidation time, not at write time: [SM] observed reconciliation commits that move transient details out of entity files (commit `c12e56c` moved a pending transfer from a person record to a workstream) [OBS SM].

### 2.5 Timeline coarsening and consolidation ("reconciliation")

- Tiers: `raw/` to `hourly/` to `daily/` to `weekly/` to `monthly/` [OBS INST]. Neither source shows the trigger.
- What is observable: ingestion and consolidation appear to run about once every 24 hours; one stated preference took about 23h16m from message to commit [OBS SM]. The memory one-pager is labeled "updated daily" and lagged by about 2 days in one probe [OBS SM]. [SM] infers a daily cron [INF].
- Reconciliation commits do more than append [OBS SM, with hashes]:
  - move temporary details into workstreams (`c12e56c`);
  - shorten durable records and link to fuller notes; compress narrative and generalize a behavioral example into a trait (`59b7f36`);
  - remove incidental details;
  - replace literal one-time codes with generic wording (`61fb47e`), so secrets did reach memory and were scrubbed later;
  - replace an incorrect claim with a dated correction (`7e9e1c2`);
  - fan one new preference out to a comms digest, the daily timeline and the dining note in a single commit (`899f88a`, agent self-report).
- Forgetting is not automatic: an explicit "this is not happening" was forgotten, but "I have my exams this weekend" persisted unless the model chose to remove it [OBS SM].
- Who writes: [INST] says the agent commits as itself; [SM] found the answering agent's memory read-only and concluded "a background process does the work of combining things, not the main agent" [OBS + INF SM]. Reconciled reading: the conversational agent reads; a separate consolidation agent (committing as "Instinct Agent") writes, in batch.
- Coarsening trigger, generator prompt, conflict handling and forget-request handling are unknown [SM].

### 2.6 Retrieval

- Keyword and grep only: no vector index, no BM25 [OBS SM]. Tools the agent reported: bash-like grep, list and git-inspect tools, plus todo tools [OBS SM self-report].
- Aliases in frontmatter are the recall mechanism: "takeout" and "pasta" find `dining`; "Italian noodles I enjoy" (paraphrase) found nothing at limits 5 and 50; "pazta" (typo) found nothing; a person's name, "my gf" and "romantic partner" all found the same person, as did the name with an extra character [OBS SM].
- Verdicts from [SM]'s vibe test: single-fact recall, recency, contradiction update, abstention and explicit personalization pass; multi-hop across sessions weak; implicit personalization fails ("Buy me a monitor" did not use known taste) [OBS SM]. Summary: "capable under explicit retrieval instructions, inconsistent in natural personalization".

### 2.7 What the answering model sees every turn (the context pack)

All [OBS SM]:

| Block | Size | Content |
|---|---|---|
| Current conversation | | Recent turns |
| Identity profile | small | Name, timezone, account email; no timestamp |
| Memory one-pager | about 4,250 tokens | Life context, **autonomy calibration**, per-channel communication style; labeled as derived from filesystem memory and updated daily; probably a derived cache, no backing file found |
| Compaction recap | about 8,750 tokens | Written by the agent at compaction; conversation anchors, open loops, exact identifiers, completed work |
| Active todo board | ids and titles only | About 25 pending and 7 in progress, with owner markers; details need todo tools |
| Session identifier | | |

- Total compacted context about 10k tokens [OBS SM]. Hard cap: when the user texts too much in 24 hours the agent says to come back tomorrow, because compaction cannot exceed a token threshold [OBS SM].
- The `knowledge/preferences/instinct/autonomy.md` file [OBS INST] and the one-pager's "autonomy calibration" block [OBS SM] are very likely the same information compiled into always-on context [INF, mine].

## 3. The box and the tools CLI

### 3.1 The box

- Rented E2B sandbox, Firecracker microVM on KVM (inferred from `pci=off`, virtio over MMIO, empty DMI, `tap0`) [OBS INST]. Ubuntu 22.04.5, 2 vCPU, 1.9 GB RAM, 29 GB disk, non-root uid 1001, systemd as PID 1, XFCE desktop, about 1.26 s cold boot to graphical target, E2B's `envd` as a service, about 30 minutes uptime seen [OBS INST]. E2B supports idle timeout and pause/resume from a memory snapshot [OBS INST, about E2B].
- No inference on the box: grepping binaries for model and provider strings found nothing [OBS INST].
- `agent-exec-server` (Go, port 8080) executes bash and code the backend sends [OBS INST]. So the model's "run bash" is a server-side decision delivered to the box, not a process the box initiates.

### 3.2 How a tool call leaves the box (the credential boundary)

1. The model (server-side) emits a shell command such as `tools gmail search ...`; the backend sends it to `agent-exec-server` [OBS INST].
2. The `tools` CLI talks to a Rust daemon listening on the Unix socket `/tmp/.tools/bridge.sock` [OBS INST].
3. The daemon forwards to a GraphQL tool-execute endpoint on `api.instinct.com`; the URL is a runtime `--base-url` argument, not compiled in [OBS INST].
4. The server executes the tool with credentials it holds (OAuth tokens, vault secrets, browser profiles); the box only sees the result [OBS INST: no credentials found besides the memory STS keys].

Why it matters: a compromised box, or a prompt-injected shell command, can call tools only through the same server endpoint, where policy and the action monitor apply. The box is hands without keys.

### 3.3 Namespaces and role tiers

- Tools come through a `tools` CLI, not MCP; `tools --help` lists about 50 namespaces including Gmail, Notion, Slack, payments and a credential vault [OBS INST].
- Help is role-aware, with three sections [OBS INST; strings from AGENT]:

| Section | Meaning (help text) | Contents seen in the task-agent view (action counts) |
|---|---|---|
| EXECUTABLE | callable by this role | `agent_message` (1), `browser_guidance` (3), `cloud_browser` (27), `cloud_browser_scheduler` (4), plus integrations, files, web fetch |
| DELEGATED | "only callable by the other role" | `account` (2), `feedback` (3), `generate_referral_link`, `revoke_referral_link`, `speak` |
| UNAVAILABLE | "does not apply to this role" | `steer_voice_agent` |

- Built-ins: `help`, `async wait`, `async list` [OBS INST]. Inference: long-running tool calls return a handle the agent can wait on or list, so a slow browser job does not block the agent's step loop.
- Reading the split [INF, mine]: everything that touches the user relationship (voice via `speak`, the account, feedback, referrals) belongs to the main agent; task agents get the grunt-work surfaces (browser, integrations, files) plus one channel upward (`agent_message`). `steer_voice_agent` being unavailable to task agents implies a third agent kind, a live voice agent the main agent steers during calls.

## 4. Main agent and task agents

- Task agent help header: spawned by a main agent for one focused job; when the job is done it reports back to its parent and **holds**; the parent owns cleanup [OBS INST]. "Holds" means it stays alive and resumable (so the parent can send follow-ups without re-priming) until the parent ends it.
- Investor description (Anish Acharya, via a competitor): a top-level agent dispatches work, with recurring loops [3P VEL].
- The post author speculates that subagents can request computers [3P INST-HN]. Users praise parallel task handling [3P DIGG-LOGIN].
- The todo board in the main agent's context carries owner markers [OBS SM], which is how the main agent keeps track of which task agent owns which job.
- Agent to agent beyond one user: a "trusted interpersonal network" where one user's agent talks to another user's agent to find shared time, with scoped access per relationship (colleagues may see only the work calendar) [CO 36KR]. Group chats: a separate group agent, siloed from members' personal accounts; a member's personal agent asks permission before connecting to the group agent and before sharing information or acting; pending replies from a personal agent are held when new members join [CO TC-GROUP].

## 5. Vault and credentials

| Capability | Detail | Source |
|---|---|---|
| `vault fill` | Types a stored credential directly into the page, so the secret never passes through chat | OBS INST |
| `vault request` | When no credential exists, mints a link the user completes | OBS INST |
| One-time codes by mail | Read automatically from the user's connected Gmail or Outlook | OBS INST |
| Own mailbox | The agent "has its own email address" and reads verification codes sent to it to finish logins | CO 36KR, ZF |
| TOTP | "Once an account's authenticator is set up in Vault, your agent can generate and enter its verification codes to unblock itself on your task." On supported services it can complete enrollment itself and save the key alongside the login; "Phone approvals and other security checks may still need your input." | CO X-TOTP (verbatim) |
| Adoption | "37% of users store at least one account password in Vault within their first three weeks" | CO X-TOTP (verbatim) |
| Uses, including HR | "32% of Instinct users already securely share their credentials with Instinct through our Vault"; uses listed include "Easy access to tax, payroll, benefits, and expense management services" | CO X-1P (verbatim) |
| 1Password | Partnership to broker credentials, rolling out to early access; mechanism unpublished; whether the agent ever sees plaintext is "not confirmed either way" | CO X-1P; 3P EXPLX |
| Phone-webview login | A webview opens on the user's phone; session cookies transfer to the agent; "The agent never receives your password"; some sites block or flag the IP change | 3P DIGG-LOGIN |
| Training | Vault materials are used only to provide the service and not to train models | CO TERMS |
| Leakage seen | Literal one-time codes reached memory and were later replaced with generic wording (`61fb47e`) | OBS SM |

## 6. Browser: leases and guidance

- Browsing does not run in the box: a separate pool of cloud Chrome instances, each carrying the user's saved profile (cookies, logins) [OBS INST].
- A task agent acquires a `lease_id` via `cloud_browser_scheduler` (4 actions; [AGENT] lists acquire, list, release, extend) and drives the browser via `cloud_browser` (27 actions) [OBS INST].
- One **write lease** per profile, the only session allowed to save new logins; up to five leases at once; releasing a lease saves its cookies so the next lease loads them [OBS INST]. This is single-writer, many-reader concurrency on a shared mutable resource (the profile), with state handed off at release.
- `browser_guidance search` (3 actions) returns curated per-site notes plus the user's past outcomes per profile; [INST] frames it as a **risk prior, not a verdict** [OBS INST]. Before acting on a site, the agent learns what tends to go wrong there and what happened last time.
- Behavior: polls when needed ("it can check every five seconds" for a restaurant booking) [CO 36KR]; early testers hit CAPTCHAs, two-factor walls and a crash on a high-demand ticket purchase [3P VEL].

## 7. Observations, feedback and learning

- `instinct-prod-observations` is a separate S3 bucket holding a raw firehose; not inspected [OBS INST]. Nothing public says what goes in it. The privacy policy lists collected categories that fit a firehose: message contents, audio and voice if enabled, clickstream ("keystrokes, clicks, cursor positions"), log, device and usage data for debugging [CO PRIV].
- Training: by default user data is used to "evaluate, fine-tune, and train the AI models"; opt-out is go-forward only and excludes data flagged for safety review; Google Workspace API data and Vault are excluded [CO PRIV, TERMS]. TechCrunch reported a "perpetual and irrevocable" license that was revised on 2026-08-26, two days after the report [3P TC-SEC].
- `feedback` (3 actions) is a main-agent-only namespace [OBS INST], so in-chat feedback becomes a tool call, which is captured data.
- Founder on tuning: internal taste testing, qualitative feedback from seed users, and A/B tests; the agent adjusts tone and level of detail per user over time [CO ZF]. Distillation and pruning "on proprietary workloads" [CO ZF] suggests the firehose feeds model distillation [INF].
- Memory-side learning is weak: within-conversation corrections work; durable learning unverified; no procedural memory seen by [SM] [OBS SM].
- The founder is first author of Reflexion, where an agent writes a verbal self-reflection after a failed attempt and stores it in an episodic memory buffer used on the next try [REFLEXION]. No source ties Instinct's design to it; `browser_guidance` "past outcomes" is the closest observed analogue [INF, mine].

## 8. Proactivity and triggers

- The agent "can wake up and sleep at any moment throughout the day based on its own judgment" [CO ILTB, via search snippet of PA/36KR coverage].
- Daily cycle example: at 6 a.m. it reviews calendar and email, returns to standby if all is fine, and interrupts only on a conflict [CO ZF].
- It phones the user unprompted only for urgent matters, about three times in a few months for the founder; "It needs to understand social situations and know when to disturb users" [CO 36KR].
- Follows up on dropped threads and contacts the user first [CO via 3P VEL].
- Over 90% of tokens will be spent in the background, not in chat; compute demand two to three orders of magnitude above reactive assistants [CO ZF].
- Push, text and local notifications, user-controlled [CO TERMS]. Inputs can arrive "actively or passively", including passive collection from connected services [CO TERMS].
- Mechanism of triggers (cron, event hooks, a wake scheduler) is not public. `cloud_browser_scheduler` is a lease scheduler, not a task scheduler [OBS INST].

## 9. Speed and cost

| Technique | Source |
|---|---|
| Self-built hybrid inference and model-distribution pipeline, claimed "close to Opus 5-level" at much lower cost; "3x to 10x more efficient than standard API pricing" | CO ZF, PA @60:27 |
| Background work needs no synchronous reply, so it runs asynchronously in batches on idle clusters, "3 to 8 times" more per-cluster throughput | CO ZF |
| Distillation and pruning on proprietary workloads, "30 to 50%" redundancy cut per stage | CO ZF |
| Answering model "likely an open-weights model" | INF SM |
| Compute is the main constraint; the CEO spends about 40% of his time on compute buying | CO PA @54:04, 36KR |
| Context pack capped at about 10k tokens; todo board as titles only; one-pager rebuilt daily (cache friendly) | OBS SM |
| Memory writes batched daily, so the answering loop never pays write-side cost | OBS SM (latency), INF |
| Retrieval is grep plus aliases: no embedding calls, no index to maintain | OBS SM |
| No model on the box; box is a commodity microVM (1.26 s boot, pause/resume) | OBS INST |
| Action monitor runs in "milliseconds", decoupled from the agent's reasoning | CO ZF |

## 10. Safety, and where it went wrong

- Content firewall: external inputs (emails, web pages) are filtered for prompt injection and social engineering before reaching the agent [CO ZF].
- Decoupled action monitor: a separate system, outside the core decision chain, audits intended actions and system calls and can block, hold, or require user confirmation [CO ZF]; "reviews every action before execution" [CO via PA @25:35, summary]. An early version shipped without content firewalls or a decoupled action monitor, which is why rollout stayed invite-only [CO PA @67:32]; the safety layer was rebuilt as an independent subsystem rather than patched [CO ZF].
- Reported incidents before that rebuild [3P TC-SEC, VEL]: an email sent without approval; following instructions planted in an email (prompt injection test); indexed inbox data retained after Google access was disconnected; messages stored as plain text for later search; a password reset done on its own to finish a purchase.
- Terms: the company "may implement safeguards, confirmation requirements, or other controls on certain Actions"; "Actions may not always be reversible"; "Records of Actions available through the Services may not always be accurate" [CO TERMS]. No spending limits described.
- Founder principles: "do not focus on capabilities first, only focus on understandability" [CO 36KR]; authorization should proceed at a pace users are comfortable with and be revocable at any time [CO 36KR].

## 11. Mapping onto Weft (payroll and HR)

Verdicts: **Copy** (take as is), **Adapt** (take the idea, change the mechanism), **Avoid**. Items already decided in `research/agent.md` are marked "(in agent.md)"; the rest are new deltas for the harness architect.

### 11.1 Memory

| Instinct pattern | Verdict | Weft (payroll/HR) |
|---|---|---|
| Git repo of Markdown, five top folders, `id`/`type`/`aliases`, `[[id]]` to `id.md` or `id/_index.md`, promotion to `_index.md` | Copy (in agent.md) | Per-company repo; types `person`, `team`, `agency`, `vendor`, `carrier`, `preference`, `procedure`, `decision`, `workstream`, `conversation`, `notice` |
| Dated fact bullets ("stated on ...") | Copy, new | Every bullet carries a simulated-clock date and a `src:` (action seq, proposal id, notice id). The model can judge staleness and the auditor can trace it. Enforce in the writer: a bullet without date and source is rejected |
| Facts in entities, events in timeline; enforced at consolidation | Adapt, new | Enforce at write time in the executor (cheap model, so do not rely on a model to clean up later): `memory.update_entity` accepts only declared durable keys per type (an employee file holds role, team, work state, manager link; never a pending action); anything time-bound must go to `timeline` or a workstream. Also run the consolidation pass (below) |
| Answering agent read-only; a batch consolidator writes | Adapt, new, important | Split writes in two. (a) Live agents only append, deterministically, through the executor: raw timeline bullets from action rows (already in agent.md step 8) and a `memory.propose_note` that queues a candidate fact. (b) A `memory-consolidation` routine on the simulated clock (nightly, or on demand in demos) turns raw timeline and queued notes into entity and knowledge edits, rolls up tiers, adds aliases, and commits as `Weft Agent`. The answering loop never pays write cost, and every durable edit is one reviewable commit per night |
| Daily latency (about 23h) for a stated preference | Avoid | Within a session the compaction recap carries it; queued notes are searchable immediately (search covers `memory/.queue/` too); consolidation can be triggered on demand by the human ("remember this now") |
| Timeline coarsening raw to hourly to daily to weekly to monthly, trigger unknown | Adapt (in agent.md 9.4, deterministic) | Trigger on simulated-clock boundaries, run inside the consolidation routine: close of hour writes `hourly/`, end of day `daily/`, Sunday `weekly/`, month end `monthly/` (aligns with payroll calendar: month end and quarter end are when 941 and SUI filings matter). Deterministic templating first; an optional model summary line per tier only for `daily` and up |
| Consolidation edits: generalize examples, shorten and link, dated corrections, remove incidentals | Copy, new | The consolidator's checklist, with corrections written as "~~old~~ corrected on <date> from <src>" so history is visible without git archaeology |
| One-time codes leaked into memory, scrubbed later | Avoid | Refuse at write time (`SECRET_IN_MEMORY`, `PII_IN_MEMORY` in agent.md); add OTP-shaped and TOTP-seed-shaped patterns to the scrubber |
| Forgetting not automatic | Adapt, new | `memory.forget {id or query, reason}` is a human-approved command that rewrites the file and records the removal in the timeline; git history keeps the old text (state this honestly in the UI: forgetting is not erasure) |
| Grep plus aliases, no vectors; misses on paraphrase and typos | Copy plus fix, new | Keep grep (no embedding cost, works offline with Qwen). Fix the two observed misses cheaply: (1) the consolidator writes aliases (synonyms, abbreviations: "SUI", "state unemployment", "UI rate"); (2) the search tool takes `terms: string[]` (1 to 5) and the prompt says to pass synonyms; (3) names resolve through `people.search` in SQLite (fuzzy), not memory grep |
| `knowledge/preferences/instinct/` (autonomy, iteration style) compiled into the always-on one-pager | Adapt, new | `knowledge/preferences/agent/autonomy.md`, `drafting.md`, `notifications.md` are compiled into the context pack as descriptive guidance. Enforcement never comes from memory: approval policy and money limits live in SQLite and the executor (agent.md 7.2). A memory edit can never loosen a policy |
| Commits as the agent; git bundle sync | Copy (in agent.md) | `Weft Agent <agent@weft.example>`, simulated-clock dates; `weft memory export` writes a bundle |

### 11.2 Context pack (new; directly serves the cheap-model goal)

Instinct's answering model gets about 10k tokens of precompiled context and pulls details with tools [OBS SM]. Weft equivalent, assembled by the harness (code, not model) in cache-friendly order:

1. Frozen core prompt plus tool registry text for the role (byte-stable, cached).
2. Company one-pager, rebuilt by the consolidation routine and dated: company facts, active states, pay schedules, autonomy calibration from `knowledge/preferences/agent/`, notification style. Changes at most daily, so it stays in the provider's prompt cache for the day ($0.02 vs $0.20 per M input on Luna).
3. Open-loops board: workstreams and pending proposals as `id | title | owner | due` lines only (Instinct's todo board with owner markers); details via tools.
4. Compaction recap when the session is long: anchors, open loops, exact identifiers (employee ids, run ids, notice numbers), completed work.
5. The volatile tail: the trigger event or user message.

Hard budget (for example 8k tokens for 2 to 4) checked in code; overflow drops the oldest recap items, never the core prompt. Instinct's "come back tomorrow" cap is the failure mode to avoid: Weft compacts instead of refusing.

### 11.3 Tools, tiers, and the hands boundary

| Instinct pattern | Verdict | Weft |
|---|---|---|
| Box holds no credentials; tool call becomes a server-side request | Copy (in agent.md decision 1) | `agent/` can only call `Executor.exec(call)`; the vault key, simulators and DB are executor-only |
| Role-aware help with EXECUTABLE / DELEGATED / UNAVAILABLE | Copy (in agent.md 7.3) | Same three sections, generated from the registry; the same text seeds task-agent prompts |
| User-relationship tools are main-only (`speak`, `account`, `feedback`, referrals) | Adapt, new | Main-only (delegated for task agents): anything addressed to a human outside the run (`comms.send_message` to an employee, notifications, creating a decision-inbox item with a question, `vault.request`). agent.md currently makes `comms.send_message` executable for task agents; recommend changing it to `D` so one voice speaks to employees and task agents stay focused |
| `async wait`, `async list` | Adapt, new | Simulators that take simulated days (state tax registration, carrier enrollment, bank settlement) return `{job_id}`; `jobs.wait {job_id, max_steps}` and `jobs.list` let an agent park; routines resume on the job's completion event instead of polling the model |
| `tools` CLI rather than MCP for its own agent | Adapt | Weft's model tools come from the registry directly; MCP is for outside clients (agent.md 14). A `weft tools` CLI renders the same registry for humans and tests |

### 11.4 Main agent and task agents

| Instinct pattern | Verdict | Weft |
|---|---|---|
| Spawned for one focused job, reports back, holds, parent cleans up | Copy (in agent.md 10) | `agent.spawn_task {kind, goal, subject_refs}`; `agent.report` returns a structured result; the task enters `held` (resumable with its transcript) until the main agent calls `agent.close_task`; a sweeper closes held tasks when the parent run ends |
| Todo board with owner markers in main context | Copy, new | The open-loops board (11.2 item 3) shows which task agent owns which workstream |
| Group agent siloed from personal agents; ask before sharing; hold pending replies when membership changes | Adapt, new | Per-company isolation is absolute (separate memory repo and DB scoping). Hold rule: if the recipient set of an outbound message changes between draft and send (an external person joins an email thread with an employee's data), the send is held for re-approval |
| Agent-to-agent trust network | Avoid for now | Out of scope; employees and admins interact through the decision inbox |

### 11.5 Vault

| Instinct pattern | Verdict | Weft |
|---|---|---|
| `vault fill` (secret goes into the page, never into chat) | Copy (in agent.md 8) | `credential_ref: "vault:<name>"` resolved inside the simulator call |
| `vault request` link | Copy (in agent.md 8) | Decision-inbox item with a fill form |
| One-time codes read from mail; TOTP generated from a stored seed; agent can self-enroll TOTP | Adapt, new, good demo | Simulated state tax portals require MFA. The executor (never the model) either generates the TOTP from a vault-held seed (RFC 6238 via `node:crypto` HMAC-SHA1) or reads the code from the simulated admin mailbox, and submits it within the simulator call. The model only sees `mfa: satisfied`. Self-enrollment of TOTP is `approval: always` because it creates a long-lived credential |
| Payroll, tax and benefits portals are a top vault use for Instinct users | Note | Confirms the Weft scenario is realistic: agency and carrier portal logins are exactly what the agent needs, and simulators should model them |

### 11.6 Guidance and leases

| Instinct pattern | Verdict | Weft |
|---|---|---|
| `browser_guidance search`: per-site notes and past outcomes as a risk prior, not a verdict | Adapt, new, high value for a cheap model | `guidance.get {target}` where target is an agency, carrier, bank or IdP simulator (for example `agency:ca-edd`): returns (1) curated notes from `knowledge/procedures/<target>.md` (seeded by us: required fields, common rejections, processing times) and (2) past outcomes computed from the action log (attempts, successes, last 3 error codes with dates). Deterministic, no model. The task-agent prompt requires one call before the first external action on a target. The prompt words it as a prior: it changes how careful the agent is, not whether it may act |
| Leases: one write lease per profile, up to 5 concurrent, release hands state to the next lease | Copy (in agent.md) and extend | One write lease per resource (payroll run, employee record, agency account, notice case); max 5 concurrent task agents. New: release persists the simulator session (the analogue of cookies) in the executor so the next lease resumes without re-login |
| Polling a site every 5 seconds | Avoid | Simulators emit events; routines subscribe. No model-driven polling |

### 11.7 Observations and learning

| Instinct pattern | Verdict | Weft |
|---|---|---|
| Raw observations firehose separate from memory | Adapt, new | An append-only `observations` table (or JSONL per day under `.data/`): every model step (tokens, cache hits, latency), tool call and refusal code, approval decision with the approver's reason, human edits to agent drafts (diff), rollbacks. It is not memory and the agent cannot read it directly. It feeds the eval set, cost dashboards, and the lesson writer below |
| Product learning via A/B tests and training on user data | Avoid | Synthetic data only; no training. Learning stays in readable files |
| Reflexion-style lessons (founder's research) and past outcomes | Adapt, new | When a proposal is denied with a reason, a filing is rejected by a simulator, or an action is rolled back, the consolidation routine writes one dated lesson bullet into `knowledge/procedures/<target>.md` with `src:` to the action seq. `guidance.get` then serves it. This is the loop that lets a cheap model improve without a bigger model: memory carries the lesson, guidance injects it at the moment it matters |
| `feedback` namespace main-only | Adapt | Thumbs and comments on agent messages land in observations and, if they carry a correction, in the consolidation queue |

### 11.8 Proactivity

| Instinct pattern | Verdict | Weft |
|---|---|---|
| Wake on own judgment; 6 a.m. review, standby if fine, interrupt only on conflict | Adapt, new, central to cost | A `morning-sweep` routine on the simulated clock. Stage 1 is code: SQL checks for payroll deadlines within N business days, unapproved runs, expiring I-9 documents, state registrations pending, new agency notices, benefits windows, unresolved proposals near expiry. If stage 1 finds nothing, no model call happens (zero tokens on a quiet day). If it finds items, stage 2 runs the main agent once with the findings as the trigger event |
| Interrupt only when needed; urgent calls rare | Adapt, new | Each finding has a severity computed in code: `interrupt` (deadline under 2 business days, failed funding, notice with a response date) goes to an immediate notification; everything else goes into a daily digest. The notifications preference file shapes wording, not severity |
| 90% of tokens in background; batched on idle clusters | Adapt | Background routine runs are not latency-sensitive: run them with low reasoning effort, the cheapest model, sequentially, and stack cache-friendly prompts. Whether OpenAI's Batch or flex tiers support `gpt-5.6-luna` on `/v1/responses` was not verified here; leave it as configuration |
| Follows up on dropped threads | Copy | Open loops with a due date and no activity for N business days become sweep findings |

### 11.9 Safety

| Instinct pattern | Verdict | Weft |
|---|---|---|
| Decoupled action monitor (block, hold, require confirmation) in milliseconds | Copy (in agent.md 7.2 as the executor policy check) | Must stay code, not a model: deterministic, testable, outside the agent's reasoning. Instinct shipped without one first and had incidents; Weft starts with it |
| Content firewall on external input | Adapt, new | Simulator inputs (agency notices, employee emails, uploaded documents) are wrapped as untrusted data with provenance (agent.md already does this for notices). Add taint: once a run has read untrusted content, any `external` or money-moving call in that run requires approval regardless of its normal policy, and the proposal shows which untrusted document preceded it |
| Unapproved send, data kept after disconnect, plaintext storage of mail | Avoid | Sends follow policy in code; disconnecting a simulated integration deletes its indexed data and records that in the action log; message bodies with PII never enter memory |
| Broad perpetual training license | Avoid | Not applicable to synthetic data; Weft's docs state that nothing is used for training |
| "Records of Actions ... may not always be accurate" | Avoid | Weft's hash-chained action log is the record of truth (agent.md 13); the UI shows it |

## 12. Sandboxes (relayed user request: open-source options and Cloudflare free tier)

The user asked to look at open-source sandboxes and Cloudflare's free tier, since Weft will not serve many users. Findings, checked 2026-10-15:

- **Weft's foundation does not need a VM sandbox.** Instinct needs a box because its agent runs bash and drives a desktop [OBS INST]. Weft's agent calls typed registry commands that the executor runs in-process against simulators (agent.md decision 1), so the executor boundary is the box. A sandbox only becomes necessary if Weft adds a free-form code tool (for example ad hoc analysis over a CSV export of synthetic payroll data).
- **Cloudflare, free tier:** no code sandbox. The Sandbox SDK (`@cloudflare/sandbox`, Containers plus Dynamic Workers) says "Available on Workers Paid plan" (https://developers.cloudflare.com/sandbox/); Dynamic Workers are "currently only available on the Workers Paid plan" (https://developers.cloudflare.com/dynamic-workers/pricing/; Paid includes 1,000 unique Dynamic Workers per day, 10M requests, 30M CPU ms). Workers Paid is $5 per month per a third-party calculator (https://flarecalc.com/calculators/containers/; not verified on Cloudflare's own pricing page). What the free tier does include that is agent-relevant: Browser Rendering, 10 minutes per day and 3 concurrent browsers (https://developers.cloudflare.com/browser-rendering/pricing/). Weft has no real browsing, so that is not needed.
- **Open source, local on the M5** (licenses and activity from the GitHub API on 2026-10-15; none tested here):
  - `apple/container` (Apache-2.0, about 50.7k stars, pushed 2026-10-14): Linux containers in lightweight VMs on Apple silicon, Swift. The most native option on this Mac.
  - `superradcompany/microsandbox` (Apache-2.0, about 8.7k stars, pushed 2026-10-15): libkrun microVMs; third-party listings say macOS (HVF) and Linux (KVM), pre-1.0 (https://rywalker.com/research/microsandbox).
  - `superhq-ai/shuru` (Apache-2.0, about 0.9k stars): microVM sandbox for agents on macOS via Virtualization.framework (third-party: https://upd.dev/superhq-ai/shuru).
  - E2B self-hosted, the stack Instinct rents: `e2b-dev/infra` now resolves to `e2b-dev/runtime` (Apache-2.0, "Cloud, Enterprise, and your own machine"). An E2B employee says it runs on any Linux box with `/dev/kvm` and on Mac via Colima [3P INST-HN]. Operating it is heavy (https://bex.co/blog/2026/09/13/e2b-self-hosted-agent-sandbox-beyond-firecracker).
  - Docker (already installed): weakest isolation but adequate for synthetic data: `--network none`, read-only input mount, CPU and memory limits, a wall-clock timeout, non-root user.
- **Suggestion [WEFT]:** no sandbox in the 9-hour foundation. If a code tool lands later, put it behind the executor as one more command (`analysis.run_python`, `effect: read`) backed by Docker with the flags above, or `apple/container`, with no credentials and no network, which keeps Instinct's rule that the box holds no keys.

## 13. Unknowns (do not design around guesses)

- Timeline coarsening triggers and the consolidation prompt [SM: unknown].
- What the observations firehose contains and whether it drives a learning loop [INST: not inspected].
- Which models answer and consolidate (open weights inferred by [SM]; proprietary pipeline claimed by [CO ZF]).
- How the main agent decides to spawn, how many task agents run in practice, and how "hold" ends.
- Whether `knowledge/procedures/` and `knowledge/preferences/instinct/` exist for all users ([INST] saw them, [SM] did not).
- How the action monitor decides between block, hold and confirm; no policy language is public.

## 14. The ten patterns that matter most for Weft, ranked

1. Brain and hands split with no credentials on the hands side; tools become server-side requests (copy; in agent.md).
2. Separate the answering loop from memory writing: live agents append deterministically; a scheduled consolidator edits entities and knowledge (adapt; new).
3. A precompiled, dated, budgeted context pack (one-pager, open-loops board, compaction recap) instead of retrieval on every turn (adapt; new).
4. A deterministic action monitor outside the model, plus taint from untrusted input (copy plus adapt).
5. Guidance as a risk prior: curated per-target procedures plus past outcomes from the action log, required before the first external action (adapt; new).
6. Code-first proactivity: a morning sweep that spends zero tokens on quiet days and interrupts only on computed severity (adapt; new).
7. Role tiers with user-facing channels owned by the main agent; task agents focus, report and hold (copy plus one change: `comms.send_message` becomes delegated for task agents).
8. Vault fill, request, and executor-side MFA (TOTP from a vault seed or code from the simulated mailbox) so the model never sees a secret or a code (adapt; new demo).
9. Lessons from denials, rejections and rollbacks written as dated, sourced procedure bullets (Reflexion-shaped, readable, no training) (adapt; new).
10. Grep plus aliases for memory search, with consolidator-written aliases and multi-term queries to fix the observed paraphrase and typo misses (copy plus fix).

Avoid: daily-only memory latency, secrets reaching memory, forgetting that silently fails, model-driven polling, acting without confirmation, keeping data after disconnect, and any training on user data.
