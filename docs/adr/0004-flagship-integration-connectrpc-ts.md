# Flagship ↔ Gibson integration: TypeScript ConnectRPC + the Capability Grant Protocol

## Status

Accepted (2026-07-31). Corrected same day — the off-cluster auth mechanism is the
**Capability Grant Protocol**, not in-cluster SPIFFE mTLS (code is ground truth:
`sdk/capabilitygrant`, `sdk/daemonclient/credentials.go`).

## Context

The flagship is a TypeScript fork of opencode (ADR-0001), so it cannot use the Go
SDK for platform integration (and no Rust SDK is being built — ADR-0003). It still
must become a Gibson component (register, harness LLM, findings, World).

It runs **off-cluster** (a customer's machine / CI), so it cannot use the
in-cluster SPIFFE-mTLS path the dashboard uses. Gibson already has the off-cluster
answer: the **Capability Grant Protocol** (`sdk/capabilitygrant`, ADR-0045 unified
CG identity runtime / ADR-0036 CG-first agent identity) — the client-side,
protocol-only (no server secrets) auth used by external agents today.

## Decision

The flagship integrates with Gibson as a TypeScript client with two parts:

1. **Auth = Capability Grant Protocol** (port `sdk/capabilitygrant` to TS):
   - Bootstrap with an **API key** (`GIBSON_BOOTSTRAP_TOKEN`) — this *is* the
     "Gibson key."
   - **Discover** `GET /.well-known/agent-configuration` (platform HTTPS).
   - **Register** a persistent Ed25519 **host key** (signs `host+jwt`) via the
     bootstrap token.
   - Per call, sign a short-lived **`agent+jwt`** with the ephemeral agent key →
     `Authorization: Bearer <agent+jwt>` per-RPC; the daemon's FGA interceptor
     authorizes it. Transport is **TLS to the platform edge (Envoy)**, not mTLS.

2. **RPC = ConnectRPC** with **connect-es** TS bindings generated from BSR
   (`buf.build/zeroroot-ai/sdk`) for `ComponentService` / `HarnessCallbackService`.

This is **not** a from-scratch full SDK — only the component/harness surface plus
the CG-protocol client. Both are protocol-only and already proven in the Go SDK.

## Consequences

- No server-side work: the daemon/dashboard already implement the CG protocol and
  the component services. This is a client port → **zerocool-only**.
- Integration ships in two depths (see `CONTEXT.md`): **Depth 1** =
  `RegisterComponent` + `ComponentService.Complete` for LLM (verified to need no
  mission run); **Depth 2** = dispatched component (`PollWork`/`Execute` +
  callback-harness) with full World/knowledge access.
- The TS bindings + CG client must track the SDK's proto/protocol version;
  regenerate from BSR on bumps.
- The daemon component surface (`ComponentService`/`HarnessCallbackService`) is
  distinct from the customer-facing `DaemonService` the dashboard uses.
