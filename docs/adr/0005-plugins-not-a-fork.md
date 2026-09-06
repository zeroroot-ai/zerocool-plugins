# Zerocool is a collection of opencode plugins, not a fork

## Status

Accepted (2026-08-03). Supersedes the "hard-fork opencode" decision in
[ADR-0001](0001-fork-opencode-drop-rig.md) for everything except one surface —
see "What still needs a fork" below. The repo was renamed `zerocool` →
`zerocool-plugins` to match.

## Context

ADR-0001 chose a hard fork of opencode and set a firm constraint on top of it:
**ship the Gibson integration as opencode-native plugins; source-fork only what a
plugin provably cannot express.** That constraint was written on the strength of
opencode's *documentation*.

Reading the actual `@opencode-ai/plugin` types changed the answer. The published
hook surface is materially richer than the docs suggest:

| Need | Hook |
|---|---|
| Register an LLM provider with no user config | `config` |
| Add tools to the agent's surface | `tool`, `tool.definition` |
| Inject context into the model's working set | `experimental.chat.system.transform`, `experimental.chat.messages.transform` |
| React to agent activity | `event` |
| Gate dangerous operations | `permission.ask`, `tool.execute.before` |
| Run execution somewhere else | `experimental_workspace.register` (remote workspace target) |
| Custom auth / provider | `auth`, `provider` |
| Clean shutdown | `dispose` |

Every Depth-1 and Depth-2 capability the flagship needed maps onto one of those.
Under ADR-0001's own constraint — fork only what a plugin cannot express — the
fork had almost nothing left to justify it.

A fork also carries costs the plugin path does not: permanent rebase churn
against a 178K★ upstream, a second distribution to build and ship, and a worse
story for users who already run opencode and simply want it to talk to Gibson.

## Decision

**Zerocool is a collection of opencode plugins.** Three layers:

1. **`@zerocool/sdk`** (repo `zeroroot-ai/sdk-ts`) — the framework-agnostic
   TypeScript Gibson SDK: BSR connect-es bindings, the Capability Grant client,
   component registration and heartbeat, the OpenAI-compatible shim, and the
   Depth-2 payload helpers. Nothing opencode-specific; any TypeScript program can
   use it.
2. **`zeroroot-ai/zerocool-plugins`** — the plugins themselves.
   `@zerocool/opencode-gibson` is the main one; `-exec` and `-sessions` are opt-in.
3. **`zerocool`** — a future branded opencode distribution that bundles the
   plugins, for the one surface below.

The CLI wrapper and branding built under ADR-0001 are **deleted**, not deprecated
(wholesale-flip discipline, ADR-0027).

## Zero-config LLM via the `config` hook

The decision that made the plugin path clearly better rather than merely
adequate.

The `config` hook lets a plugin inject provider configuration at config-load
time. So with a Gibson key present, the plugin registers a `gibson` provider
pointing at a local OpenAI-compatible shim it started, and the user selects a
`gibson/<slot>` model. **No `opencode.json` editing, no documented setup step.**

That is a better user experience than the fork would have delivered, because a
fork would still have had to configure the provider somewhere — it would just
have shipped the file.

Ordering is a type-level guarantee, not a timing assumption: `Plugin` returns
`Promise<Hooks>`, so opencode cannot reach the `config` hook until the plugin body
has resolved, and the body starts the shim before it builds the hook object.

## What still needs a fork

**Dispatched mode** (`zerocool-plugins#14`) — the daemon driving an opencode
session as a Gibson component (`PollWork`/`Execute` + callback harness). A plugin
reacts to a session; it cannot *be* the thing that starts one from outside. That
is an external driver over opencode's server, and it is the only surface left
that justifies a distribution of our own.

## Consequences

- **Upstream churn drops to near zero.** The plugins depend on a published,
  versioned hook contract instead of on internal source.
- **Existing opencode users are addressable.** Installing a plugin is a smaller
  ask than switching distributions — Gibson interop stops being all-or-nothing.
- **Fork ethics get simpler.** ADR-0001 reasoned carefully about forking MIT code
  respectfully. Not forking sidesteps the question for everything except #14.
- **We are bound to the hook surface.** Anything opencode does not expose, we
  cannot do — `experimental.*` hooks may move under us, and there is no patching
  around a gap. Accepted: the surface already covers every capability in the
  backlog, and #14 is the escape hatch.
- **Standalone must stay first-class.** A plugin that breaks opencode when Gibson
  is unreachable is worse than no plugin, so every failure path degrades to
  standalone rather than refusing to start.

## References

- [ADR-0001](0001-fork-opencode-drop-rig.md) — the superseded fork decision and
  the plugin-first constraint that drove this reversal.
- [ADR-0004](0004-flagship-integration-connectrpc-ts.md) — the TypeScript
  ConnectRPC + Capability Grant integration, unchanged by this ADR.
- [`CONTEXT.md`](../../CONTEXT.md) — the current layer boundaries.
