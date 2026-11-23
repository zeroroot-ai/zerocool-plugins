# @zeroroot-ai/zerocool-claude-member

The always-on Claude Code member driver for Gibson banks
(ADR-0158).

A **bank** is N Claude Code instances a person or a tenant asked for. The
daemon keeps N **members** running in launcher sandboxes (a Firecracker machine each). This package is the
process inside one sandbox. It holds the **job table**, one Claude Code
process per active job, the **workspace manager**, and the status heartbeat.

The driver spawns the unmodified `claude` CLI. It never uses the Agent SDK
and never changes the binary, because the Claude Code hosting terms require
both (ADR-0158).

## What a job is

One structured input opens a job: a goal, repositories with a connector
reference and a deliverable, credential names, input World node ids, and an
acceptance rule. The job owns one persistent Claude Code session and its own
worktrees. Unrelated jobs never share a conversation or a worktree.

    open ──turn──▶ working ──result──▶ waiting ──turn──▶ working
      │                                   │
      └────────── close / abandon ────────┴──▶ closed

The names are the wire's. Job states are `open`, `working`, `waiting` and
`closed` (`gibson.job.v1.JobState`). Verdicts are `accomplished`, `failed` and
`abandoned` (`JobVerdict`). Input kinds are `open`, `turn`, `answer`,
`wrap_up` and `close` (`OpenJob`, `InputKind`, `CloseJob`). Deliverables are
`NONE`, `PUSH_BRANCH` and `MERGE_REQUEST` (`DeliverableKind`). A member
reports `launching`, `needs_sign_in`, `idle`, `busy` or `draining`
(`gibson.bank.v1.MemberState`; the daemon decides `dead` when the heartbeats
stop).

The worker never closes its own job. A scorer does. Then the driver runs the
wrap-up, performs the deliverables, removes the worktrees and reports idle.

## The environment contract

The daemon sets these when it launches a member sandbox.

| Variable | Required | Meaning |
|---|---|---|
| `GIBSON_MEMBER_ID` | yes | the member this sandbox serves |
| `GIBSON_BANK_ID` | yes | the bank it belongs to |
| `GIBSON_CG_JWT` | yes | the member base grant |
| `GIBSON_CALLBACK_ENDPOINT` | yes | the harness endpoint, `host:port` or a URL |
| `GIBSON_CALLBACK_INSECURE` | no | `1` dials plaintext, for a local daemon |
| `GIBSON_PLATFORM_CA_PEM` | no | the platform's private CA as PEM, when the edge does not chain to public roots. See below. |
| `GIBSON_SANDBOX` | yes | `launcher`. The daemon sets it when the sandbox runs in the launcher backend of setec. See below. |
| `GIBSON_INSTANCE_MODE` | no | `member` (default) or `one-shot` |
| `GIBSON_MISSION_ID` | no | the mission the member runs under |
| `ZEROCOOL_LOGIN_SHAPE` | no | `api-key` (default), `subscription`, `bedrock`, `vertex`, `foundry` |
| `ZEROCOOL_CLAUDE_MODEL` | no | passed as `--model` |
| `ZEROCOOL_JOB_CAP` | no | jobs in flight, default 1. The member refuses to start with a value above 1, see below |
| `ZEROCOOL_WORKSPACE` | no | workspace root, default `/workspace` |
| `ZEROCOOL_STATE_DIR` | no | driver state. Default `/tmp/zerocool` under the sandbox marker, `~/.zerocool` elsewhere. See below. |
| `ZEROCOOL_CLAUDE_BIN` | no | the `claude` bin, default `claude` |
| `ZEROCOOL_CLAUDE_MAX_TURNS` | no | `--max-turns` per turn, default 200 |
| `ZEROCOOL_CLAUDE_MAX_BUDGET_USD` | no | `--max-budget-usd` per turn |
| `ZEROCOOL_MCP_URL` | no | the localhost Gibson MCP server URL |
| `ZEROCOOL_JOB_STALE_LIMIT_MS` | no | idle limit before `abandoned`, default 24h |
| `ZEROCOOL_HEARTBEAT_MS` | no | heartbeat cadence, default 30s |
| `CLAUDE_CONFIG_DIR` | no | Claude Code's own config dir, per member. Default `<state dir>/claude-config` |

The provider credential (`ANTHROPIC_API_KEY`, or the cloud provider's
variables) reaches the Claude Code child and nothing else. The driver never
reads it, never logs it and never writes it to disk.

### The sandbox marker

The driver runs Claude Code with `--dangerously-skip-permissions` on every
turn. The launcher sandbox and the per-turn grant are the controls that make
that safe, so the driver starts only where the sandbox is. `GIBSON_SANDBOX`
is the daemon's statement that it launched this process in the launcher sandbox. The
driver refuses to start when the marker is absent or carries another value,
and `claudeArgs` refuses to build an argv without it. This package ships a
bin, and the same code must not run prompt-free on a laptop.

### The state directory

The driver keeps its state in one directory: `platform-ca.pem`, `jobs.json`
and the Claude config dir. A setec sandbox mounts a read-only root
filesystem. Its writable paths are `/tmp`, the scratch volume every sandbox
gets, and `/workspace` on a session sandbox. The home directory is on the
root filesystem, so nothing can be written there.

When `ZEROCOOL_STATE_DIR` is unset and `GIBSON_SANDBOX` is `launcher`, the
state dir is `/tmp/zerocool`. The image sets the same value. Outside the
sandbox the default is `~/.zerocool`. The choice is made from the marker
alone, never from a probe: a fallback that depends on what happens to be
writable would hide a misconfiguration.

At start, before anything is written, the driver creates the state dir and
writes one probe file to it. When that fails, the driver refuses to start
with one line that names `ZEROCOOL_STATE_DIR`, the path and the reason.

### The platform CA

A self-hosted install fronts its edge with a private CA, and Envoy serves a
certificate that chains to it. A sandbox carries only environment, so the
daemon hands that CA over as PEM in `GIBSON_PLATFORM_CA_PEM`. The variable is
absent when the edge chains to public roots.

At start the driver writes the PEM to `platform-ca.pem` under
`ZEROCOOL_STATE_DIR`, mode 0600. An empty value, a value that is not PEM, or
a value that carries a key is refused with the reason. The driver trusts the
file beside the public roots on every gRPC transport it builds: the harness
callback and the component heartbeat. Every child it spawns, the `claude` CLI
and the `gibson-mcp` server, gets the file in `NODE_EXTRA_CA_CERTS`, so their
platform calls verify too. The PEM itself never reaches a child.

`GIBSON_CALLBACK_INSECURE` is a different thing: plaintext for a local
daemon. The platform CA is TLS with a private root, verification on.

## What the Claude child sees

`claudeChildEnv` builds the child environment from an allow list. A cloud
credential passes only for its login shape: `AWS_*` for `bedrock`, `GOOGLE_*`
and `CLOUD_ML_REGION` for `vertex`, `AZURE_*` for `foundry`. No
`GIBSON_*` grant, no `ZEROCOOL_*` knob and no git token reaches the model's
process. `NODE_EXTRA_CA_CERTS` passes, so the child trusts the platform CA.
The member holds no forge credential, and `git` runs on local files only. The
daemon refuses to give an untrusted sandboxed agent a tenant secret, so the
workspace reads and delivers through governed connector tools.

## Two shapes, one path

A **member** pulls jobs from the daemon and runs until it is stopped. A
**one-shot** dispatch is the same driver with a different inbox: the launch
supplies one job, the driver runs one turn, and it closes the job itself,
because there is no scorer in that shape. The verdict is `pass` when the
turn's `result` says `is_error: false`, and `fail` otherwise. `sandbox.js` is
the one-shot bin.

A one-shot task says what it wants in the `Task` context, with the same keys
the opencode dispatch uses: `repository.url`, `repository.branch`,
`repository.name`, `repository.connector`, `repository.project`, `repository.paths`,
`repository.deliverable`, `credentials` (comma separated), `input.nodes` and
`acceptance`.

## What the driver talks to

| Seam | RPC |
|---|---|
| inbox subscription | `HarnessCallbackService.SubscribeInput`, a lifetime stream on the base grant, reconnected with backoff |
| job queue | `HarnessCallbackService.PullJob` when a slot is free |
| job state | `HarnessCallbackService.ReportJobState` on every turn boundary |
| deliverables | `HarnessCallbackService.ReportDeliverable` at wrap-up |
| repository read and delivery | `HarnessCallbackService.CallToolProto` with the `invoke_tool` meta-tool, under the grant of the turn |
| member status | `ComponentService.Heartbeat`, with `gibson.bank.v1.MemberStatus` |

An RPC the daemon refuses never ends the member. A refused heartbeat is
logged once per distinct failure and the heartbeat keeps its cadence. A
refused pull is retried with the inbox backoff, 500 ms doubling to 30 s. The
next heartbeat carries the failure: `health_status` reads `degraded` and
`health_message` ends with `last error: <source>: <message>` until that
source succeeds again. The driver exits on a configuration error before the
first heartbeat (a missing variable, an unwritable state dir, no sandbox
marker) and on a stop signal. Nothing the daemon says ends it.

Each input carries the grant of its own dispatch. The driver puts that grant
in force for the turn it runs and drops it after. A pulled job carries none,
so its first turn runs on the member base grant.

A `RepositorySpec` names a connector (`connector/<name>`) and a project in the
connector's own terms. It names no url and no secret.

## One job at a time

The member refuses to start with `ZEROCOOL_JOB_CAP` above 1, because `fetch_file`
is wired. Every job's Claude runs as the same user in the sandbox. One job could
read the worktree of another, or call the `fetch_file` endpoint of the other
job's turn. The cap rises only when each job's Claude runs under its own user.
A closed job that is still delivering keeps its slot until the delivery ends.

## How a job reads and delivers a repository

The workspace uses the git-host tools of the connector. It never clones, never
pushes and holds no token. The daemon binds a fix to its job only when
`open_merge_request` opened the merge request, so a pushed branch would never
link. The workspace is sparse and read on demand.

1. At the first turn that carries a grant, `list_tree` pages the whole tree of
   the base branch. The driver keeps the listing (path, type, sha, mode) in a
   record under the state dir, not in a git ref. `read_file` reads only the
   files the job names (the context key `repository.paths`). The driver writes
   them under `jobs/<job id>/<repo name>`.
2. Claude has one member tool, `mcp__workspace__fetch_file(path)`. It calls
   `read_file` under the grant of the current turn, writes the file and records
   its sha as the base of that path. A file that `read_file` refuses (not text,
   too large, encoding none) is never written, and the refusal goes back to
   Claude. If the sha differs from the listing, the base branch moved and the
   fetch is refused.
3. At wrap-up the driver lists the files that git does not ignore, with the
   `.gitignore` files of the repository in force, and adds the fetched files.
   The listing runs against an empty index that the driver owns under the state
   dir, so a file that Claude staged or committed is still in the change.
   The driver fetches every listed `.gitignore`, root and nested, in `prepare`.
   `dist/`, `node_modules/`, a venv and a cache are ignored, and a nested git
   repository is never entered. The driver compares each file with the record by
   content hash. A change is an edit or a delete of a fetched path, or an add of
   a path that the listing does not hold, with no file above it and no folder
   at it. A listed path that was never fetched, a symbolic link, a submodule, a
   path below a file, a mode change or a new executable file is refused.
4. The driver reads each changed path again. If a sha differs, or an added path
   now exists, the base branch moved and nothing is opened.
5. The driver checks every repository first and opens none if one is refused.
   It then calls `open_merge_request` once for each repository, with `project`,
   `base_branch`, the branch `job/<job id>`, a title (at most 256 bytes), a
   description (at most 20,000 bytes) and the changed `files`.
6. The driver reports the `merge_request` key and the `url` with
   `ReportDeliverable`. If an open fails after another opened, the job is
   reported as failed and the error names the opened merge requests.

Every call runs under a live grant of a turn of the job, never the member base
grant, so the daemon binds each call to the job. The driver keeps that grant
alive: the harness of the grant calls `RenewCapabilityGrant` before it expires,
for the whole turn and before the wrap-up open. A pulled job carries no turn
grant, so its workspace stays unread until an input with a grant arrives.

A failure that carries a retryable code (TIMEOUT, UNAVAILABLE or
RESOURCE_EXHAUSTED, or a transport failure with the matching gRPC code) is tried
again with backoff inside the close, for at most five minutes. The code is the
only classification: the text of an error is never read, and a failure with no
retryable code is permanent. After a stop begins, a delivery keeps trying for at
most 30 seconds, and the drain waits for it. A newer turn grant of a job
releases the earlier grants of the job. After that, or on a permanent refusal, the job is failed with its
reason, the workspace is removed and the job record is dropped. Nothing
outlives the close.

The tool limits are 100 files, 1 MiB for one file and 8 MiB in all, as UTF-8
text with the byte order mark kept. An over-limit or refused delivery opens
nothing and fails the job (`isError`). The refusal is the result of the job: a
console line of type `zerocool` and subtype `delivery_refused` (or
`delivery_waiting` when a later try can succeed), the log, and the `error` of
the deliverable report. A truncated tree is refused before the first turn. The
job closes as `failed` and the console shows subtype `workspace_refused`. If a
job is resumed and its directory is gone, the first turn tells Claude that its
earlier edits were lost. `PUSH_BRANCH` is refused at wrap-up, because no tool
pushes a branch.

## Teardown and resume

A `wrap_up` input is the scorer's `CloseJob` reaching the member. The driver
runs one last turn with the wrap-up prompt (commit on the job branch, write a
summary of what was done and what remains), then opens the merge request,
archives the transcript, reports the close, removes the worktrees and drops
the job. A `close` input does the same without the final turn, and the stale
limit does it with verdict `abandoned`.

The transcript is what Claude Code wrote under
`$CLAUDE_CONFIG_DIR/projects/<key>/<session_id>.jsonl`, subagent files
included. It goes to the session store under the job id, in chunks under
1 MiB behind one manifest. A member relaunched after a sandbox death gets the
job back from the daemon with its session id, restores the transcript from
the store, and its first turn passes `--resume`, so the conversation
continues. The workspace is built again from the base branch. Work that no
merge request carried is gone with the sandbox.

On SIGTERM the driver interrupts the turns in flight with SIGINT, waits up to
the grace period (`stopGraceMs`, default 30 s), archives every live job and
reports `member stopping`, then exits.

## The Gibson MCP server

The tools reach Claude Code from `@zeroroot-ai/gibson-mcp`, run as its own
process on a loopback port inside the sandbox. The driver starts it, waits
for `/healthz`, and gives Claude Code `--mcp-config <path>`, `--strict-mcp-config`
and `--permission-prompt-tool mcp__gibson__ask`. The file holds
`{"type":"http","url":"http://127.0.0.1:<port>/mcp"}` and the per-turn
`fetch_file` endpoint. It has mode 0600 in a 0700 folder of the job under the
state dir, and it is deleted when the turn ends. The argv never carries a URL.

Before each turn the driver puts that dispatch's grant in force with
`POST /turn {job_id, grant, callback_endpoint, insecure}`, and ends it with
`DELETE /turn` when the turn is over. Between turns the server falls back to
the member base grant. A stdio server that Claude Code spawns per session
cannot swap a grant per turn, which is why the transport is HTTP.

`/turn` is authenticated. The Claude Code child shares the sandbox's network
namespace and has a shell, so an open control plane would let it install or
drop any grant it has seen. The driver mints one random bearer token per
process, starts the server with it in `GIBSON_TURN_TOKEN`, and sends it as
`Authorization: Bearer` on every `POST` and `DELETE /turn`. The token is a
`GIBSON_` name, so the child environment never carries it. After the server
answers `/healthz`, the driver sends one unauthenticated `POST /turn` and
requires a 401. A server that accepts it is not the control the design
names, and the driver refuses to run under it.

`ZEROCOOL_MCP_BIN` names the server bin (default `gibson-mcp`).
`ZEROCOOL_MCP_URL` attaches to a server that is already running instead of
starting one. That path needs `GIBSON_TURN_TOKEN` set to the token the
running server was started with, and the same 401 check applies.

## Subscription sign-in

With `ZEROCOOL_LOGIN_SHAPE=subscription` the member runs on a person's own
Claude login, never on a platform credential. The driver spawns
`claude auth login` inside the sandbox, reads the authorization URL and the
paste prompt from its stdout, and relays both to the console through a
`SignInRelay`. The code the person pastes goes back on the CLI's stdin. A
refused code is reported and the attempt continues, because the CLI keeps
waiting. Success is confirmed with `claude auth status --json`.

The bank owner starts the flow from the console. The daemon sends the word
`start` as a turn on the control job `sign-in`, and later the pasted code as
an answer on the same job. These inputs open no job. The relay prints one JSON
line for each step on the event stream that the console follows: `sign_in`
with the URL and the prompt, then `sign_in_invalid`, `sign_in_done` or
`sign_in_failed`. The daemon forwards these lines to the owner and stores
none of them. One attempt runs at a time, and a stop cancels it.

The platform never sees the credential. This driver never reads, copies or
logs `.credentials.json`, and never logs the URL or the code. The credential
lives in `CLAUDE_CONFIG_DIR` on the sandbox's ephemeral disk and dies with the
sandbox.

A member on the subscription shape refuses to start when `ANTHROPIC_API_KEY`
or `ANTHROPIC_AUTH_TOKEN` is set, because the key would win over the login.

## Tests

    pnpm --filter @zeroroot-ai/zerocool-claude-member test

The stream-json fixtures come from Claude Code 2.1.257. See
[`test/fixtures/README.md`](test/fixtures/README.md) for what is a real
capture, what is `synthetic-until-captured`, and the re-capture procedure for
a version bump.
