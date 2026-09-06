# sdk-rs (a Rust Gibson component SDK) — dropped

## Status

Dropped (2026-07-31). Briefly accepted the same day, then dropped when the
flagship base flipped to opencode (ADR-0001).

## Context

`sdk-rs` was to be a faithful, complete Rust clone of the Go SDK — making Rust a
first-class component-authoring language, peer to Go, and serving as the flagship
coding agent's integration path.

Two things removed its consumers:

1. **The flagship went TypeScript** (opencode fork, ADR-0001) and integrates via a
   TS ConnectRPC client (ADR-0004) — it never needed a Rust SDK.
2. **Produced components are polyglot** and join the fleet by conforming to
   Gibson's language-neutral component contract (gRPC `AgentService`/`ToolService`
   or the executor proto-ABI + manifest + image) — not via a Rust-specific SDK.

## Decision

**Do not build `sdk-rs`.** A dedicated Rust SDK has no consumer on any critical
path. Produced *Rust* components (should any exist) use raw BSR-generated
tonic/prost bindings directly against the daemon contract; the Go SDK remains the
one first-class SDK, and Rust is one of many contract-conformant languages.

## Consequences

- One fewer repo/track to build and version against the Go SDK's protos.
- If a first-class Rust authoring experience is ever wanted, revisit — the Go SDK
  is the reference and BSR is the proto source. Nothing here blocks that.
