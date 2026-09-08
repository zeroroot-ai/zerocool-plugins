# zerocool-plugins

**Zerocool is a collection of coding-agent plugins (opencode, Claude Code) for
Gibson interoperability.**
Install a plugin, and opencode gains Gibson: LLM through the harness, tools,
findings, the knowledge graph, delegation/missions — with a bootstrap key.

## Three layers (all branded zerocool)

1. **`@zeroroot-ai/sdk`** (repo [`sdk-ts`](https://github.com/zeroroot-ai/sdk-ts)) — the
   framework-agnostic TS Gibson SDK: connect-es bindings (BSR), Capability Grant
   auth, component register/heartbeat, the session singleton, the OpenAI-compat
   shim. Nothing opencode-specific. Any TS program can use it.
2. **`zerocool-plugins`** (this repo) — the opencode plugins that import the SDK.
3. **`zerocool`** (later) — a branded opencode **fork** that *inserts* these plugins
   and carries any **core** patches for the one thing a plugin cannot do (#14).

## The collection

| Package | What | Adoption |
|---|---|---|
| **`@zeroroot-ai/zerocool`** (main) | session check-in (Capability Grant + RegisterComponent + heartbeat), **zero-config LLM** (a `config` hook adds `provider.gibson` pointing at the SDK shim), Gibson tools, findings (`event`→Emit), knowledge (`system.transform`/recall tool), delegate/missions | one install, most value |
| **`@zeroroot-ai/zerocool-exec`** (opt-in) | route execution into the setec **Devbox** via `experimental_workspace.register` (#12) | invasive — changes where code runs |
| **`@zeroroot-ai/zerocool-claude`** (Claude Code) | MCP server + hooks. The session is a **live mission** (one AGENT node naming this component, task grant from the dispatch). `remember` = `Observe(MemoryObservation)`, `recall`, `world_view`, findings, Gibson tools, delegation. **Never routes LLM**: the user's Claude subscription pays for the model. ADR-0007. | one install, needs `GIBSON_TARGET_ID` for the live posture |
| **`@zeroroot-ai/zerocool-sessions`** (opt-in) | mirror the session to the daemon **session-context store** on `session.updated`/`message.updated`, restore on start (#11) | invasive — changes where state lives |

## The store seam (#11)

`@zeroroot-ai/zerocool-sessions` keeps a copy of an opencode session in the
tenant's trusted store, so the session survives a restart of the host.

The store is three RPCs on `HarnessCallbackService`: `PutSessionContext`,
`GetSessionContext` and `DeleteSessionContext`. The daemon holds one opaque
blob per **(tenant, session_id)** in the per-tenant dataplane Postgres and
never reads the bytes. The tenant half comes from the caller's identity, so no
request names a tenant and one component cannot reach another's session. A
write carries an etag: an empty etag means create, a stale etag comes back
`Aborted`, and the writer reads the current version and retries once. The blob
cap is 8 MB.

**It mirrors, it never replaces.** opencode owns its session format and its
local disk. Replacing that storage needs the fork, not a plugin. So the plugin
copies, and a restore adopts the stored version instead of rebuilding the
session.

**The session id is opencode's own.** `session.updated` carries the session
record and `message.updated` carries a message that names its session, so the
plugin reads the id off the event. It mints no second identity, and `DevboxExec`
in #12 keys its Devbox on the same id.

**Local context never reaches the Devbox.** The store is the trusted home for
it, which is why the plugin calls only the session RPCs and never a workspace
one.

Three modes, chosen once at start: a dispatched run writes on the task grant
(`GIBSON_CALLBACK_ENDPOINT` + `GIBSON_CALLBACK_TOKEN`, which wins when both are
present), an interactive one writes on the component grant from the host key
the main plugin registered, and anything else is standalone with no mirror and
no hooks. A store that answers `Unavailable` or `Unimplemented` stops the
mirror after one warning, and the session stays on opencode's disk.

## Boundary — plugin vs core

The opencode plugin API is rich (`config`, `provider`, `auth`, `tool`, `event`,
`chat.*`/`system.transform`, `permission.ask`, `tool.execute.*`, `shell.env`,
`experimental_workspace`, `dispose`). So **almost everything is a plugin**,
including zero-config LLM and Devbox execution.

**The one thing that is not a plugin: #14 dispatched mode** — an external driver
over opencode's server/SDK (`PollWork` → run opencode headless). Deferred to the
`zerocool` fork.

A shared **Gibson session singleton** lives in `@zeroroot-ai/sdk` so multiple plugins
share one Capability-Grant auth + one `RegisterComponent`.

## Dispatched task kinds

A sandboxed dispatch serves one **task kind**, named by the mission node in the
Task context key `zerocool.task` (`ZEROCOOL_TASK` forces it for a hand-run
sandbox). Three exist:

| Kind | What it does | Ends |
|---|---|---|
| `opencode` (default) | Drives `opencode run` headless on the Task goal. | When opencode returns. |
| `source-analysis` | semgrep produces candidates, the model triages them, real ones are submitted as Findings. Changes no file. | When the checkout is analysed. |
| `watch` | Polls the Application's GitLab project and originates a **Scan mission** per finished pipeline on the branch. | Never on its own. The mission is cancelled or the sandbox is torn down. |

`watch` is the **Always-on agent** shape (gibson `CONTEXT.md`). It is the
machine identity that starts scans: ADR-0063 admits a component as a mission
originator only from inside a mission it was dispatched to, so a GitLab job
cannot originate a Scan mission whatever credential it holds. A person
originates the long-lived `watch-<application>` mission once, and every Scan
mission after that is the agent's, through `CreateMission` on its dispatch
grant.

**Task context is `TypedValue`, never a bare string.** gibson dispatches the
Task as `protojson.Marshal(agent.TaskToProto(task))`, and both `context` and
`metadata` are `map<string, gibson.common.v1.TypedValue>`, so every value
arrives as `{"stringValue":"..."}`. A decoder that keeps only plain strings
drops every key, including the `zerocool.task` selector.

## Open platform-side item

Devbox execution (#12) uses opencode's **remote-workspace** protocol — the Devbox
must run that endpoint. This likely supersedes the `DevboxExec` RPC design in
gibson#1183 (to be re-scoped).

## Glossary (2026-09-01 grill, in progress)

- **Gibson MCP server** — the one MCP tool surface for every coding agent host
  (Claude Code, opencode, Cursor, Codex CLI, Gemini CLI, Windsurf). Stdio MCP.
  It exposes everything the TS SDK produces, 1:1: one tool per RPC of every SDK
  service, one tool per SDK helper, and one tool per checked-in platform tool
  discovered at runtime. One flat tier, no curated subset. The tool set is
  generated from the SDK's proto descriptors, so an SDK bump regenerates it.
  Lives in `sdk-ts` as the workspace package `@zeroroot-ai/gibson-mcp`, built
  by the same generate step as the connect-es clients, released on the SDK train.
  Supersedes the Claude-only server in `packages/claude-gibson` (deleted, ADR-0027).
  Decided in [ADR-0008](docs/adr/0008-gibson-mcp-server-one-tool-surface.md).
- **Host adapter** — the thin per-host bundle around the Gibson MCP server:
  the Claude Code plugin (bundle + SessionStart/SessionEnd hooks), the opencode
  plugin (LLM provider shim, `system.transform`, `event`), and config snippets
  for hosts with no hook surface. An adapter holds no tools of its own. Decided in [ADR-0008](docs/adr/0008-gibson-mcp-server-one-tool-surface.md).
- **Check-in source** — how the Gibson MCP server gets its credential. Three,
  chosen by what is present at start, never mixed: (1) *dispatched grant*: the
  daemon launched the process, `GIBSON_CG_JWT` + callback endpoint are the only
  credential, the server joins the run it was launched for, no enrollment, no
  state file; (2) *pre-minted token*: a person minted a one-time bootstrap token
  earlier, the server checks in unattended with it once, host key thereafter;
  (3) *human once*: device-flow login in the session, host key thereafter.
  Priority: dispatched grant wins. The server never mints identity (ADR-0045).
  Decided in [ADR-0008](docs/adr/0008-gibson-mcp-server-one-tool-surface.md).
- **Claude Code instance** — one Claude Code process the daemon launched in an
  ephemeral setec sandbox (ADR-0016), driven headless with stream-json on stdin
  and stdout. Two shapes from one image: *one-shot* (a goal, no stdin, ends with
  the result, like the opencode agent) and *session* (long-lived, takes turns
  until stopped). Both are one mission run and one sandbox. Blocker 6 does not
  apply: the process lives for the whole run, so every turn sees one worktree.
- **Agent session** — the daemon-owned resource behind a session-shaped
  instance. Input is one RPC, `SendInput(session_id, message)`, written by a
  person (dashboard), another agent (harness callback, so it is also a Gibson
  MCP tool), or a tool or job, each under its own principal. `DelegateToAgent`
  with a `session_id` targets a running session instead of launching a new
  sandbox. The sandbox pulls input outbound through `SubscribeInput` under the
  task grant and never accepts an inbound connection. setec `Attach` is not
  used. Output is `StreamAgentEvents` plus the turn result in the session store.
- **End event** — what ends an instance: Stop (person or owning agent),
  turn done (one-shot only), idle timeout, max lifetime, mission cancel or
  tenant disable, credential revoked, sandbox death. All but the last are graceful: the daemon
  closes the input stream, sends SIGTERM, waits the grace period, then setec
  `Kill`. The run records the end event as its reason.
- **Checkpoint** — what the driver saves before exit, under the task grant:
  the worktree to the session's branch (`WorkspaceCommit`, `WorkspacePush`),
  the Claude Code transcript to the session store, and the final result. The
  provider credential is never checkpointed. Nothing else survives the sandbox.
- **Resume** — `ResumeSession` launches a new sandbox, restores the branch and
  the transcript, and starts Claude Code with `--resume`. A stopped session is
  not final. Idle limits can therefore be short.
- **Login shape** — how a Claude Code instance authenticates to Anthropic.
  Three, all offered (the Claude Code terms forbid restricting a built-in
  method): *subscription*, *Anthropic API key*, *third-party provider*
  (Bedrock, Vertex, Foundry). API key and third-party credentials come from
  the tenant provider configuration and the manifest `credentials` block,
  injected at launch (gibson#1621, already built for `agent/claude`). A
  subscription is never stored by the platform: the person signs in inside
  the sandbox, in the unmodified `claude` binary, through Anthropic's own
  flow, relayed through the console. One-shot instances cannot use a
  subscription (no person present). The driver spawns the CLI, never the
  Agent SDK, because the hosting exemption names the binary. Source: Claude
  Code docs, Legal and compliance, "Can customers offer Claude Code in their
  products?" (read 2026-09-01). gibson#1621 "never on a subscription" is
  superseded by this.
- **Bank** — a declarative, daemon-reconciled pool of always-on Claude Code
  instances: owner, desired count, login shape, image and model, repo
  template, idle policy, spill policy (queue or ephemeral launch when no
  member is idle). Owned by one person (a subscription sign-in is theirs) or
  by the tenant on the tenant API key; same resource, different owner and no
  sign-in step. The daemon launches until the desired count runs, relaunches
  a dead member, and holds a member at `needs sign-in` until its owner
  completes the in-sandbox login through the console. Members are never
  finished until the bank scales down, so the reaper leaves them alone.
  Sized small at idle: the manifest gives a low request and a higher limit.
- **Member** — one instance in a bank. An always-on mission the owner
  originated (ADR-0063, the same shape as the `watch` task kind), with an
  agent session as its input. One turn at a time, so a bank of N is N
  parallel turns. Reached only through `SendInput`; `can_send` on the bank
  decides who may. Missions reach a bank through a target selector on
  `DelegateToAgent`: ephemeral launch (today), a named bank, or a session id.
- **Per-turn grant** — the identity rule for a long-lived member. One
  sandbox serves many dispatches over its life, so every input message
  carries the task grant of its own dispatch and every tool call in that turn
  uses it. The driver runs the Gibson MCP server over streamable HTTP on
  localhost inside the sandbox, holds the inbox subscription, and swaps the
  grant per turn. A stdio server Claude Code spawns cannot do this. ADR
  candidate: long-lived single-user sandbox, per-turn task grants, MCP over
  localhost HTTP (amends ADR-0016's one-run-one-sandbox rule).
- **Job** — the unit of work a member holds. Opened by the first structured
  input (a `Task` with typed fields: goal, repositories with connector ref
  and deliverable, credential names, input World node ids, acceptance,
  constraints). Owns one Claude Code session (transcript on disk, reopened
  with `--resume`), its worktrees, and a state: `open`, `working`,
  `waiting`, `closed`. Every later input names the job id and carries the
  sender's grant for that turn. Unrelated jobs never share a conversation or
  a worktree. A chat turn from the console is a job with only a goal. Nothing
  arrives at a member as a bare string.
- **Close** — the wrap-up signal. The worker never closes its own job. A
  scorer does (a verification agent, a person, or the mission node after its
  acceptance step): `CloseJob(job_id, verdict, score)`. The driver sends one
  final wrap-up turn (commit, push, open the merge request, summarize), then
  removes the worktrees, archives the transcript to the session store,
  reports deliverables and verdict on the run, and drops the job. A job idle
  past the bank's stale limit closes with verdict `abandoned`. Nothing else
  deletes a worktree.
- **Workspace manager** — the member-side part of the driver. One clone per
  repository per member, kept warm; one `git worktree add` per job on a
  branch named by the job id; clones evicted by disk cap, least recently
  used. Prepares worktrees and credential names before the turn, tells
  Claude the paths and the deliverable in the appended system prompt.
- **Member status** — what a member reports on every heartbeat: `jobs in
  flight`, `cap`, `busy` (in flight equals cap) or `idle`, and `needs
  sign-in`. The daemon holds a per-bank job queue. A member with a free slot
  pulls the next queued job for its bank, the way `PollWork` pulls today. A
  bank with no free slot queues, or spills to an ephemeral launch, per its
  spill policy. Capacity of a bank = members × jobs-in-flight cap.
- **Job node** — `NODE_TYPE_JOB`, the mission node that drives a job on a
  bank. Its executor runs the verify loop internally: open the job, dispatch
  the acceptance step to the declared verifier component, on failure send
  the verifier's report as the next input to the same job, repeat up to the
  node's `RetryPolicy`, then `CloseJob` with verdict and score. The mission
  graph stays a DAG: no loop edges. Only the job node executor and a person
  may call `CloseJob`. The node declares acceptance: verifier component and
  passing score. Each pass is an attempt in the run history.
- **Permission posture** — a job runs Claude Code with
  `--dangerously-skip-permissions`; the gVisor sandbox and the per-turn grant
  are the controls (non-root image, which the flag requires). Outward side
  effects are *deliverables* the driver performs at wrap-up under the job's
  declared deliverable and the base-grant connector token: push, merge
  request, finding status. Claude commits on the job branch and never holds
  the token. Questions to a person go through one Gibson MCP tool, `ask`,
  wired as `--permission-prompt-tool`: the job enters `waiting` and the next
  input is the answer.
- **Bank exit test** — `exit-test-bank.yml` in gibson, on `main` and on a
  schedule, never on a PR (ADR-0012). Real model only, on a real key from a
  repository secret; no stub Messages API. Asserts lifecycle and
  deliverables, not model text: two members reach `idle`; a job from a
  scanner-shaped test component turns one member `busy`; the worktree exists
  on the job branch; the verifier fails pass one and the same Claude session
  takes pass two; `CloseJob` lands; the worktree is gone; push and merge
  request are recorded; the member is `idle` again; a sender without
  `can_send` and an undeclared credential name are refused. It feeds the
  scorecard and blocks nothing.

