# The Claude Code plugin: the session is a live mission

## Status

Accepted (2026-08-28, owner decisions on gibson#1593, items 9 to 11). Extends
[ADR-0005](0005-plugins-not-a-fork.md) to a second host and exercises the
dispatched shape of [ADR-0006](0006-kind-agent-dispatched-shape.md) for an
interactive session.

## Context

Zerocool was a collection of opencode plugins. Many people run Claude Code on a
Claude subscription and want the same Gibson interoperability without a second
model bill. Claude Code has three extension surfaces: an MCP server, hooks, and
the plugin bundle that ships both. Every opencode hook the main plugin uses maps
onto one of them, with one exception: the `config` hook that swaps the model
provider to the Gibson harness.

Two platform facts shape the design.

1. **The World is written under a mission.** `Observe` is the only write and the
   projector the only graph writer (gibson ADR-0012). Every callback RPC
   resolves the harness from `ContextInfo{mission_id, agent_name}`, and the
   scope of every observation is the mission's target. There is no write for a
   component that is not running a mission.
2. **Memory was removed as a store.** The `Memory*` RPCs are gone. A shape the
   Taxonomy does not know lands as an `Observation` node with the residue kept.
   That is the write a memory needs.

## Decision

1. **A Claude Code plugin ships beside the opencode plugin**, from this repo,
   as `packages/claude-gibson` (`@zeroroot-ai/zerocool-claude`). Same SDK,
   same enrollment, same host key. One enrollment serves both plugins on a host.
2. **The model stays on the user's Claude subscription.** The plugin never
   routes LLM traffic through the harness and never reads or sets an Anthropic
   key or base URL. This is the one opencode feature it drops.
3. **Launching Claude Code creates one live mission for the session.** The
   person originates it: the MCP server builds a mission with one AGENT node
   that names this component and submits it through the CLI login session
   (`gibson mission submit`), because a component may originate a mission
   only from inside one it was dispatched to (gibson ADR-0063). The daemon
   dispatches the node to this component, which claims its own
   `agent_execute` dispatch and holds the task grant from then on. The session has parity with a dispatched agent: `Observe`,
   `WorldView`, `QueryNodes`, the session store, tools and delegation. The
   mission completes when Claude Code closes the server's stdio.
4. **Memory is `Observe(MemoryObservation)`.** No memory store, no memory API,
   no local mirror. `remember` is a tool the model calls. Nothing writes a
   memory on its own.
5. **The target is the user's.** A component cannot create a target (the Target
   RPCs admit USER and SERVICE identities only). A person creates one target
   per workspace and sets `GIBSON_TARGET_ID`. Without it the session runs as a
   component: reads and findings work, memory writes do not.
6. **Three postures, one path.** Standalone (no platform), component (checked
   in, no mission), live (mission). Each step down removes tools. The plugin
   fails open at every step, as the opencode plugin does.

## Consequences

- The hook processes cannot reach the MCP server. The server writes the
  ambient knowledge block and the live-mission coordinates to
  `~/.zerocool/claude/` (mode 0600). The SessionStart hook injects the block.
  The SessionEnd hook checkpoints the transcript to the session store under
  the task grant. Both fail open.
- One mission per launch adds `mission.started` and `mission.done` events to
  the tenant Timeline and one Mission node to the graph per session. That is
  the attribution ADR-0012 asks for, not noise.
- Platform work this depends on: gibson#1602 (a live node must not fail at the
  5-minute work-queue wait), gibson#1603 (the work grant's allowed list),
  gibson#1605 (ext-authz must accept a daemon-minted task grant as the sole
  credential of an off-cluster component).
