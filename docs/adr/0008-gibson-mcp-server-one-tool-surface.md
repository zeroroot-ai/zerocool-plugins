# The Gibson MCP server is the one tool surface. Hosts are adapters.

## Status

Accepted (2026-09-01, owner decisions 1 to 4 and 9 on zeroroot-ai/gibson#1706).
Amends [ADR-0005](0005-plugins-not-a-fork.md) and
[ADR-0007](0007-claude-code-plugin-session-is-a-live-mission.md). Terms come
from [`CONTEXT.md`](../../CONTEXT.md) § Glossary: *Gibson MCP server*, *Host
adapter*, *Check-in source*.

## Context

Two implementations of one tool set existed. The opencode plugin registered
its tools in process through the `tool` hook. The Claude Code plugin shipped a
second server in `packages/claude-gibson` with a hand-written subset of the
same tools. Each new SDK helper had to land twice, and the two lists drifted.

The owner asked for 1:1 parity with the SDK. Every RPC of every service, every
SDK helper, and every platform tool that checked in at runtime must reach the
model as a tool. A curated subset hides platform work from the agent.

Every coding agent host the epic names speaks stdio MCP: Claude Code, opencode,
Cursor, Codex CLI, Gemini CLI, Windsurf. A tool that lives in an MCP server
reaches all six. A tool that lives in an opencode hook reaches one.

## Decision

1. **One server.** `@zeroroot-ai/gibson-mcp` lives in `sdk-ts` as a workspace
   package. The same generate step that emits the connect-es clients emits one
   MCP tool per RPC of every SDK service, from the proto descriptors. A second
   pass adds one tool per SDK helper. At start the server discovers the
   platform tools checked in for the tenant and adds one tool per platform
   tool. The tool set is one flat tier. There is no curated subset. The
   package releases on the SDK train, so an SDK bump regenerates the tools.

2. **Hosts are adapters.** An adapter holds no tools. The opencode plugin
   keeps three hooks: `config` (the LLM shim, ADR-0005), `system.transform`
   (ambient knowledge), and `event` (findings and session events). The Claude
   Code plugin keeps the bundle and two hooks, SessionStart and SessionEnd.
   Cursor, Codex CLI, Gemini CLI and Windsurf get a config snippet that names
   the server binary. Nothing else is host-specific.

3. **Three check-in sources, never mixed.** The server takes its credential
   from what is present at start, in this order:
   1. *Dispatched grant.* The daemon launched the process. `GIBSON_CG_JWT`
      and `GIBSON_CALLBACK_ENDPOINT` are the only credential. The server
      joins the run it was launched for. No enrollment and no state file.
   2. *Pre-minted bootstrap token.* A person minted a one-time token earlier.
      The server checks in unattended with it once and uses the host key
      after that.
   3. *Human once.* Device-flow login inside the session, then the host key.

   The dispatched grant wins when it is present. The server never mints an
   identity (gibson ADR-0045).

4. **The driver spawns the unmodified `claude` CLI, never the Agent SDK.** The
   Claude Code hosting terms name the binary and forbid changes to it. The
   terms also require that each end user authenticates with a credential of
   their own. The member driver in this repo (`packages/claude-member`) runs
   `claude` as published, with stream-json on stdin and stdout, and every
   login shape the binary offers stays reachable. The quote is below.

## The Claude Code hosting terms

From the Claude Code documentation, "Legal and compliance", section "Can
customers offer Claude Code in their products?" (code.claude.com, read
2026-09-01):

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code
> in your products or services (e.g. in hosted sandboxes or other agent
> infrastructure) requires agreeing to our Commercial Terms of Service and
> complying with the conditions below:
>
> * **The Claude Code binary must not be modified.** Claude Code must be
>   installed and run as published by Anthropic, and customers may not remove,
>   disable, or restrict any authentication method built into it (including
>   methods that permit signing in with a Claude account or the user's own API
>   key).
> * **Customers may not pay for, resell, or intermediate Claude usage on their
>   end users' behalf.** Each end user must authenticate with their own
>   Anthropic API key, Claude subscription plan credentials, or 3P inference
>   provider credential (Amazon Bedrock, Google Cloud's Agent Platform,
>   Microsoft Foundry). That usage is billed directly to the end user under
>   their own agreement with Anthropic or, for third-party inference
>   providers, with the applicable provider.

Two rules in this repo follow from that text. The image installs
`@anthropic-ai/claude-code` from npm at a pinned version and changes nothing in
it. The platform never stores a Claude subscription credential. A person signs
in inside the sandbox through the flow the binary provides, or the tenant
supplies its own API key or cloud provider credential.

## Consequences

- **`packages/claude-gibson` tool code is deleted, not deprecated** (ADR-0027).
  The server, the tool modules and the session code in that package go. The
  bundle keeps the plugin manifest, the two hooks and an `.mcp.json` that
  names `@zeroroot-ai/gibson-mcp`. No compatibility shim stays behind.
- **ADR-0007 decisions 1 and 2 stand.** A Claude Code plugin ships from this
  repo, and the model stays on the user's Claude subscription. ADR-0007
  decision 3, one live mission per session, moves into the Gibson MCP server.
  The server originates the session mission at start under the *human once*
  or *pre-minted token* source, and joins the existing run under the
  *dispatched grant* source. The hooks keep only what a hook can do: inject
  the ambient block and checkpoint the transcript.
- **ADR-0005 narrows.** The opencode plugin drops its in-process tools. The
  `config` hook, `system.transform` and `event` remain the reason the plugin
  exists. The `-exec` and `-sessions` plugins are unchanged.
- **Parity is mechanical.** A new RPC in the SDK reaches every host on the next
  SDK release with no work in this repo. A drift guard in `sdk-ts` fails when
  the generated tool set and the descriptors disagree.
- **One flat tier is large.** The tool list a host shows the model grows with
  the SDK. The owner accepted this. A host that needs fewer tools filters on
  its side with its own allow list, never through a second server.
- **The driver is bound to the CLI contract.** Argument names, the stream-json
  event shapes and the exit codes of `claude` are the interface. The member
  driver pins the version it was tested against and captures fixtures from
  that version.

## References

- zeroroot-ai/gibson#1706, the epic and its owner decisions.
- zeroroot-ai/sdk-ts#56 to #60, the server slices.
- zeroroot-ai/zerocool-plugins#102, #103, #104, the adapter slices.
- [ADR-0005](0005-plugins-not-a-fork.md), [ADR-0007](0007-claude-code-plugin-session-is-a-live-mission.md).
- gibson ADR-0027 (hard cut, no parallel paths), ADR-0045 (the server never
  mints identity).
