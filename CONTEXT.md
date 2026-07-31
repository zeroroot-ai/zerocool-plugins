# zerocool — flagship coding agent

> Named for *Hackers* (1995) protagonist Zero Cool — ties the platform's
> hacker-culture "Gibson" lineage and the `zero-*` brand (zero-day, zeroroot).

A **curated Gibson flagship**: an autonomous red/blue **security-tooling factory**,
driven from a **CLI**, never an editor/IDE. A customer says "build me a fuzzer
agent that can attack C binaries" and it builds, tests, and ships that tool (red
or blue). A **hard fork of [opencode](https://github.com/sst/opencode)**
(TypeScript, MIT — the most-mature OSS coding agent), chosen because the goal is
**superior in all ways + highly extensible + deeply platform-integrated**, and
that outweighs language-consistency (Rust is a preference, not a requirement).

It runs **standalone** (opencode as-is, BYO LLM key) and, when a Gibson key is
entered, swaps its backends to gain the full **Platform** feature set. Fully open;
the moat is Platform *infrastructure* (fleet, sandbox, World, hosting), not
withheld code.

> Founding decisions: [ADR-0001](docs/adr/0001-fork-opencode-drop-rig.md)
> (fork opencode / drop rig), [ADR-0002](docs/adr/0002-standalone-platform-seam-fully-open.md)
> (two-mode seam / fully open), [ADR-0003](docs/adr/0003-sdk-rs-rust-component-sdk.md)
> (sdk-rs — dropped), [ADR-0004](docs/adr/0004-flagship-integration-connectrpc-ts.md)
> (flagship↔Gibson = TS ConnectRPC).

## Two modes, one binary (the seam)

The Gibson key does not unlock agent features — it swaps pluggable backends:

| Seam | Standalone | Platform (Gibson key) |
|---|---|---|
| **Model** (LLM) | opencode's provider layer (AI SDK / models.dev), **BYO LLM key** | route through Gibson harness via **ConnectRPC** — `ComponentService.Complete*`, slot-addressed (budget, per-tenant creds, tracing; eino behind it) |
| **Executor** (run code) | direct-on-host, permission-prompted (opencode default) | setec **Devbox** microVM |
| **Store** (checkpoint) | opencode's local session store | trusted daemon session store |
| **Knowledge/Policy** | none / local | **World** + **FGA** + findings graph + missions |

**Two keys, not one.** An **LLM key** is needed even standalone (it's a coding
agent). The **Gibson (zeroroot) key** is separate and swaps the backends.

## Base & integration

**Base:** hard fork of opencode (TypeScript). rig is not involved (opencode uses
the AI SDK / models.dev provider layer). Chosen over the Rust option (VTCode)
because the priorities are superiority + extensibility + curated-flagship;
Rust-consistency is a preference, not a constraint.

**Flagship ↔ Gibson integration is TypeScript**, reusing the platform's **proven
dashboard pattern** — ConnectRPC over SPIFFE mTLS — and generating **connect-es**
bindings for `ComponentService` / `HarnessCallbackService` from BSR
(`buf.build/zeroroot-ai/sdk`). This is *not* a from-scratch SDK; it reuses the
dashboard's transport/identity path (ADR-0004).

**No dedicated Rust SDK.** `sdk-rs` was considered and **dropped** (ADR-0003):
the flagship is TS, and produced components are polyglot via Gibson's
language-neutral contract, so a Rust-specific SDK has no critical-path consumer.
Produced *Rust* components (if any) use raw BSR-generated tonic/prost bindings.

**Produced-agent framework is customer-specified** (LangChain, Go, C, rig, Rust…
no mandate). Produced components join the fleet by conforming to Gibson's
language-neutral component contract (gRPC `AgentService`/`ToolService` or the
executor proto-ABI + manifest + image), not to any framework.

## Language

**Coding Agent**:
The curated flagship (`DISPATCH_MODE_AGENT`; TypeScript, hard fork of opencode)
that does code work. One core, two triggers: mission-dispatched (Platform,
autonomous) and human-session (both modes).
_Avoid_: coding session (that is one run of it), the agent (unqualified).

**Devbox**:
The **session-lifetime** setec microVM that holds the worktree and runs every
byte of build / test / exec / offensive script on Platform. **Untrusted.** One
per coding session; persists across turns, reattaches by handle. (Standalone runs
direct-on-host instead — opencode's default.)
_Avoid_: sandbox (unqualified — setec also has per-call sandboxes).

**Local context**:
The agent's private working memory — conversation, plan/todos, compacted history,
file-map, edit journal. Standalone: opencode's local session store. Platform:
trusted daemon session store. **Never** projected into the World; **never** stored
on the Devbox volume.
_Avoid_: agent memory (collides with the forbidden cross-mission recall API).

**Offensive artifact**:
A throwaway recon/exploit script the agent writes and runs against a target, then
discards. The code is a means; the deliverable is a Finding/observation.
_Avoid_: tool (a registered capability), deliverable.

**Deliverable code**:
Durable code the agent produces *as its output* — a patch, a tool, an agent, a
PR — held to a security bar. Goes through the workspace → commit → PR.
_Avoid_: artifact.

## Relationships

- A **Coding Agent** run = the agent (TS) + its execution home (host standalone /
  **Devbox** on Platform) + (Platform) the **World** it reads and Emits to.
- The agent **reads** the World (ambient projection) and contributes
  **Findings**/decisions/deliverable-references — it does **not** store Local
  context in the World.
- **Factory outputs are polyglot.** Standalone → a self-contained, tested repo.
  Platform → the same artifact is also **componentized** (wrapped to the Gibson
  component contract) and **registered into the fleet**, dispatchable under RoE.
- Repo content (files, dep READMEs, test output) is **untrusted input**.

## Platform integration — two depths (sequenced)

**Depth 1 — "to start": register + LLM-through-Gibson.** The agent checks in as a
component (`RegisterComponent` + SPIFFE + capability grant, over ConnectRPC) and
routes LLM through `ComponentService.Complete` (harness-proxied: slots, budget,
per-tenant creds, tracing). The agent keeps its own CLI loop — a *client of the
daemon* for LLM. This is the **Model seam** only.

**Depth 2 — "eventually, fully": transformed into a dispatched component.** Daemon
drives via `PollWork`/`Execute` + callback endpoint; the agent uses the
callback-harness for tools **and the knowledge graph** — ambient World
projection, GraphRAG, `Emit`/`SubmitFinding`, `DelegateToAgent`, missions. Peer to
native agents. This is the **Knowledge seam** + full harness surface.

Check-in is required even at Depth 1 (identity/authz/budget); being *dispatched*
is what's new at Depth 2.

**Verified — Depth 1 is viable with no mission run** (gibson
`internal/platform/component/service.go:1169`): `Complete`/`CompleteStream`
require only tenant (from the SPIFFE/ext-authz identity) + a `slot` name +
messages; `WorkId`/mission is **optional** (`resolveMissionContext` falls back to
tenant-level defaults). Budget/traces attribute at **tenant level** absent a
session; a per-session run is an optional refinement (CLI-sessions PRD #738), not
a blocker. Caller must hold a **COMPONENT** identity, so `RegisterComponent` is
required. `CompleteWithTools`/`CompleteStructured` exist too — the tool-calling
loop is covered. **Model-seam mapping:** opencode's "which model" → Gibson `slot`.

## Build order

1. **TS integration lib** — connect-es bindings from BSR + a ConnectRPC-over-
   SPIFFE-mTLS client (reuse the dashboard's pattern); `RegisterComponent` →
   `Heartbeat` lifecycle + capability grant.
2. **Model seam** — an opencode provider that routes LLM through
   `ComponentService.Complete*`; map model → slot.
3. **Depth 1 ships** — connected agent routes LLM through Gibson; human still
   drives the CLI loop.
4. **Harness knowledge surface** — GraphRAG reads, `Emit`/`SubmitFinding`,
   ambient World projection, `DelegateToAgent`, missions.
5. **Depth 2** — transformed into a dispatched component; componentize + register
   produced artifacts into the fleet.
6. **Executor seam** — setec Devbox for sandboxed execution on Platform.

A single track — the flagship's TS integration above. (No `sdk-rs`; see dropped.)

## Considered and dropped

- **Verb / three-layer offensive-generation engine** (Primitives → Patterns →
  Free composition; plan-not-code; plan-hash cache; open pattern catalog).
  Coherent idea, **dropped** — a capable coding agent writes offensive tooling
  when prompted; the value is the wiring, not a bespoke engine.
- **Rig as the substrate.** Dropped early; the flagship is opencode (TS).
- **VTCode (Rust) as the base.** Strong Rust option, but under the
  superior+extensible+curated-flagship priorities, opencode's maturity/ecosystem
  won; Rust demoted to a preference. See ADR-0001.
- **`sdk-rs` / a dedicated Rust SDK.** Dropped — a TS flagship + polyglot
  component contract leaves no critical-path consumer (ADR-0003).
- **Gating / closed seams.** Fully open; no offensive-capability gating.

## Flagged ambiguities

- "state lives in the World" (ECS glossary) vs **Local context** — resolved:
  durable *shared* knowledge → World; private *churny* working memory → Local
  context (trusted, checkpointed). Local context is **not** the forbidden
  "agent memory API" (that was cross-mission *recall*, not private scratch).
- "execute sessions in the sandbox" — resolved: the *execution* session runs in
  the **Devbox** (Platform); the *reasoning*/loop is the agent.
