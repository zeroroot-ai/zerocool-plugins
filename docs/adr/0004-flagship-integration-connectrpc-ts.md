# Flagship ↔ Gibson integration is a TypeScript ConnectRPC client, reusing the dashboard pattern

## Status

Accepted (2026-07-31)

## Context

The flagship is a TypeScript fork of opencode (ADR-0001), so it cannot use the Go
SDK for platform integration (and no Rust SDK is being built — ADR-0003). It still
must become a Gibson component
(register, harness LLM, findings, World) — the deep-integration promise of the
curated flagship.

## Decision

The flagship integrates with Gibson over **ConnectRPC on SPIFFE mTLS**, reusing
the **dashboard's proven pattern** (the dashboard already talks to the daemon this
way). Generate **connect-es** TypeScript bindings from BSR
(`buf.build/zeroroot-ai/sdk`) for `ComponentService` and `HarnessCallbackService`,
and build a thin TS integration lib on the dashboard's transport/identity path.

This is **not** a from-scratch or full TypeScript SDK — only the component/harness
surface the agent needs, on reused transport.

## Consequences

- No new SDK language commitment beyond what the platform already carries (the
  dashboard is TS + ConnectRPC).
- Integration ships in two depths (see `CONTEXT.md`): **Depth 1** =
  `RegisterComponent` + `ComponentService.Complete` for LLM (verified to need no
  mission run); **Depth 2** = dispatched component (`PollWork`/`Execute` +
  callback-harness) with full World/knowledge access.
- The TS bindings must track the SDK's proto version; regenerate from BSR on bumps.
- Note the daemon component surface (`ComponentService`/`HarnessCallbackService`)
  is distinct from the customer-facing `DaemonService` the dashboard uses today —
  same transport/identity pattern, different services to generate.
