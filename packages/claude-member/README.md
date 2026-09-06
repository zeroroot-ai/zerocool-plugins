# @zeroroot-ai/zerocool-claude-member

The always-on Claude Code member driver for Gibson banks
(zeroroot-ai/gibson#1706, [ADR-0008](../../docs/adr/0008-gibson-mcp-server-one-tool-surface.md)).

A **bank** is N Claude Code instances a person or a tenant asked for. The
daemon keeps N **members** running in gVisor sandboxes. This package is the
process inside one sandbox. It holds the **job table**, one Claude Code
process per active job, the **workspace manager**, and the status heartbeat.

The driver spawns the unmodified `claude` CLI. It never uses the Agent SDK
and never changes the binary, because the Claude Code hosting terms require
both (ADR-0008).

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
| `GIBSON_INSTANCE_MODE` | no | `member` (default) or `one-shot` |
| `GIBSON_MISSION_ID` | no | the mission the member runs under |
| `ZEROCOOL_LOGIN_SHAPE` | no | `api-key` (default), `subscription`, `bedrock`, `vertex`, `foundry` |
| `ZEROCOOL_CLAUDE_MODEL` | no | passed as `--model` |
| `ZEROCOOL_JOB_CAP` | no | jobs in flight, default 1 |
| `ZEROCOOL_WORKSPACE` | no | workspace root, default `/workspace` |
| `ZEROCOOL_WORKSPACE_CAP_BYTES` | no | clone cache cap, default 20 GiB |
| `ZEROCOOL_STATE_DIR` | no | driver state, default `~/.zerocool` |
| `ZEROCOOL_CLAUDE_BIN` | no | the `claude` bin, default `claude` |
| `ZEROCOOL_CLAUDE_MAX_TURNS` | no | `--max-turns` per turn, default 200 |
| `ZEROCOOL_CLAUDE_MAX_BUDGET_USD` | no | `--max-budget-usd` per turn |
| `ZEROCOOL_MCP_URL` | no | the localhost Gibson MCP server URL |
| `ZEROCOOL_JOB_STALE_LIMIT_MS` | no | idle limit before `abandoned`, default 24h |
| `ZEROCOOL_HEARTBEAT_MS` | no | heartbeat cadence, default 30s |
| `CLAUDE_CONFIG_DIR` | no | Claude Code's own config dir, per member |

The provider credential (`ANTHROPIC_API_KEY`, or the cloud provider's
variables) reaches the Claude Code child and nothing else. The driver never
reads it, never logs it and never writes it to disk.

## What the Claude child sees

`claudeChildEnv` builds the child environment from an allow list. No
`GIBSON_*` grant, no `ZEROCOOL_*` knob and no git token reaches the model's
process. The connector token goes to `git` alone, through `GIT_ASKPASS`, and
is never written to disk or placed on a command line.

## Two shapes, one path

A **member** pulls jobs from the daemon and runs until it is stopped. A
**one-shot** dispatch is the same driver with a different inbox: the launch
supplies one job, the driver runs one turn, and it closes the job itself,
because there is no scorer in that shape. The verdict is `pass` when the
turn's `result` says `is_error: false`, and `fail` otherwise. `sandbox.js` is
the one-shot bin.

A one-shot task says what it wants in the `Task` context, with the same keys
the opencode dispatch uses: `repository.url`, `repository.branch`,
`repository.name`, `repository.connector`, `repository.credential`,
`repository.deliverable`, `credentials` (comma separated), `input.nodes` and
`acceptance`.

## What the driver talks to

| Seam | RPC |
|---|---|
| inbox subscription | `HarnessCallbackService.SubscribeInput`, a lifetime stream on the base grant, reconnected with backoff |
| job queue | `HarnessCallbackService.PullJob` when a slot is free |
| job state | `HarnessCallbackService.ReportJobState` on every turn boundary |
| deliverables | `HarnessCallbackService.ReportDeliverable` at wrap-up |
| connector token | `HarnessCallbackService.GetCredential` under the base grant |
| member status | `ComponentService.Heartbeat`, with `gibson.bank.v1.MemberStatus` |

Each input carries the grant of its own dispatch. The driver puts that grant
in force for the turn it runs and drops it after. A pulled job carries none,
so its first turn runs on the member base grant.

A `RepositorySpec` names a connector and a project, not a url and not a
secret. The job spec's `context` map carries the rest:
`connector.<ref>.credential` names the tenant secret, and
`ZEROCOOL_CONNECTOR_BASE_URL` or `connector.<ref>.base_url` gives the host.
Without them the driver falls back to `<connector name>-connector-cred` and
`https://gitlab.com`.

## Teardown and resume

A `wrap_up` input is the scorer's `CloseJob` reaching the member. The driver
runs one last turn with the wrap-up prompt (commit on the job branch, write a
summary of what was done and what remains), then performs the deliverables,
archives the transcript, reports the close, removes the worktrees and drops
the job. A `close` input does the same without the final turn, and the stale
limit does it with verdict `abandoned`.

The transcript is what Claude Code wrote under
`$CLAUDE_CONFIG_DIR/projects/<key>/<session_id>.jsonl`, subagent files
included. It goes to the session store under the job id, in chunks under
1 MiB behind one manifest. A member relaunched after a sandbox death gets the
job back from the daemon with its session id, restores the transcript from
the store, and its first turn passes `--resume`, so the conversation
continues. The worktree comes back from the pushed `job/<job id>` branch when
one exists.

On SIGTERM the driver interrupts the turns in flight with SIGINT, waits up to
the grace period (`stopGraceMs`, default 30 s), archives every live job and
reports `member stopping`, then exits.

## The Gibson MCP server

The tools reach Claude Code from `@zeroroot-ai/gibson-mcp`, run as its own
process on a loopback port inside the sandbox. The driver starts it, waits
for `/healthz`, and gives Claude Code `--mcp-config` with
`{"type":"http","url":"http://127.0.0.1:<port>/mcp"}`, `--strict-mcp-config`
and `--permission-prompt-tool mcp__gibson__ask`.

Before each turn the driver puts that dispatch's grant in force with
`POST /turn {job_id, grant, callback_endpoint, insecure}`, and ends it with
`DELETE /turn` when the turn is over. Between turns the server falls back to
the member base grant. A stdio server that Claude Code spawns per session
cannot swap a grant per turn, which is why the transport is HTTP.

`ZEROCOOL_MCP_BIN` names the server bin (default `gibson-mcp`).
`ZEROCOOL_MCP_URL` attaches to a server that is already running instead of
starting one.

## Subscription sign-in

With `ZEROCOOL_LOGIN_SHAPE=subscription` the member runs on a person's own
Claude login, never on a platform credential. The driver spawns
`claude auth login` inside the sandbox, reads the authorization URL and the
paste prompt from its stdout, and relays both to the console through a
`SignInRelay`. The code the person pastes goes back on the CLI's stdin. A
refused code is reported and the attempt continues, because the CLI keeps
waiting. Success is confirmed with `claude auth status --json`.

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
