# One binary, two modes via backend seams; fully open; two keys

## Status

Accepted (2026-07-31)

## Context

The coding agent must work **standalone** on a generic Linux box (exactly
Claude-Code-shaped) *and* gain the full Gibson platform (knowledge graph, ACLs,
isolated execution, budget, fleet) when connected — without a second codebase or
a parallel code path.

## Decision

A **single binary** with four **pluggable backend seams**, selected at runtime:

| Seam | Standalone | Platform |
|---|---|---|
| **Model** (LLM) | opencode providers (AI SDK / models.dev), **BYO LLM key** | Gibson harness over ConnectRPC (`ComponentService.Complete*`, slot-addressed; budget, per-tenant creds) |
| **Executor** (run code) | direct-on-host, permission-prompted (opencode default) | setec **Devbox** microVM |
| **Store** (checkpoint) | opencode local session store | trusted daemon session store |
| **Knowledge/Policy** | none / local | **World** + **FGA** + findings graph + missions |

(Base is opencode/TypeScript per ADR-0001; the seam concept is language-independent.)

**Two distinct keys.** An **LLM provider key** is needed even standalone (it's a
coding agent — it needs a model). A separate **Platform (zeroroot) key** swaps the
backends. The Platform key does not unlock agent *features*; it swaps *backends*.

**The product is fully open.** No offensive-capability gating (illusory anyway —
general coding competence can't be withheld). The moat is Platform
**infrastructure** (fleet, sandbox, World, hosting), i.e. the self-hosted↔SaaS
**deployment-profile seam** ([workspace ADR-0006](../../../../enterprise/platform/gibson/docs/adr)),
not a runtime license gate or withheld code.

## Consequences

- **One code path in both modes** (ADR-0027 discipline): the seam impls differ,
  the loop does not.
- "Secure" splits honestly by tier: **standalone** secures *the code it writes*
  (verification); **Platform** adds *secure execution* (Devbox) + ACLs + knowledge.
- Standalone is inherently interactive-human-session only; autonomous
  mission-dispatch is a Platform capability (sidesteps gibson ADR-0008 until
  Platform autonomy lands).
