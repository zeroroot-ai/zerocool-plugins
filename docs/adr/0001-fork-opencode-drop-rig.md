# Fork opencode as the base; drop rig; produced-agent framework is the customer's choice

## Status

Accepted (2026-07-31). Supersedes the initial VTCode decision (same date) — see
"Reversal" below.

## Context

The flagship coding agent is to be **superior in all ways, highly extensible, and
a deeply platform-integrated curated Gibson flagship**. Under those priorities,
**Rust is a preference, not a requirement.**

- **[opencode](https://github.com/sst/opencode)** (SST) — TypeScript, MIT, 178K★
  — is the most-mature OSS coding agent: deepest feature set, a plugin/extension
  ecosystem, a server/SDK, MCP, custom commands, strong LSP. Best ceiling on
  "superior + extensible," and its client/server shape is a natural
  platform-integration seam for a curated flagship.
- **[VTCode](https://github.com/vinhnx/VTCode)** — Rust, MIT/Apache — is the
  strongest *Rust* option and was the initial pick, but it is younger and
  single-maintainer; not "superior in all ways" against opencode's ecosystem.

rig was only ever a means to an LLM seam + agent loop; it was dropped early and is
independent of the base choice (VTCode was never rig-based — an early
marketing-vs-code correction).

## Decision

**Hard-fork opencode (TypeScript) as the flagship (`zerocool`). Drop rig.** The agents the factory *produces* use **whatever framework the
customer specifies** (LangChain, Go, C, rig, Rust…) — no mandated substrate;
produced components join the fleet by conforming to Gibson's language-neutral
component contract (gRPC/ABI + manifest + image), not to any framework.

## Reversal

This reverses the earlier same-day decision to fork VTCode. The trigger was an
explicit reprioritization: the optimization target changed from
"Rust-consistent + good" to "superior + highly extensible + curated flagship,"
with Rust demoted to a preference. Under the new weighting opencode's
maturity/ecosystem/extensibility win. The cost accepted: a TypeScript flagship
that integrates via a TypeScript ConnectRPC client (ADR-0004); the previously
planned Rust SDK (`sdk-rs`) is dropped (ADR-0003).

## Licensing, attribution & fork ethics

Forking opencode and rebranding it is **permitted and normal** — MIT expressly
allows fork / modify / rename / extend / commercialize. It is not "shady" provided
three things hold; hiding the origin is the only thing that would make it so.

1. **Attribution (MIT requirement + norm).** Preserve opencode's copyright notice
   and MIT license text in the distribution; state "built on opencode" prominently
   in the README/docs. Lead with the origin — never imply we wrote the base.
2. **Trademark (why we rename).** MIT licenses the *code*, not the *name/logo*.
   Shipping as "opencode" would imply endorsement and confuse users — so renaming
   to our own brand (`zerocool`) is the *correct, respectful* move, not the shady
   part. Never use opencode's name/logo as ours or imply endorsement.
3. **No rug-pull.** We stay fully open and build a materially different product (a
   Gibson-integrated security-tooling factory), not a reskin-and-resell. Credit
   upstream; contribute fixes back where practical.

**License:** `zerocool` is **MIT** (inherit opencode's; add our copyright). Keep a
`NOTICE`/`LICENSE` preserving opencode's copyright when its code lands.

**Fork depth is a live decision (plugin-first vs hard-fork).** opencode has a
plugin/extension system. Doing the Gibson integration as **plugins + a curated,
branded distribution** — hard-forking only what we can't do as a plugin — is both
more respectful (uses supported extension points; easier to contribute back) and
lighter to maintain (a heavy source fork means perpetual merge churn against a
fast 178K★ project). **Default posture: plugin-first; hard-fork only where
necessary.** Revisit as integration needs become concrete.

## Consequences

- The flagship is TypeScript. This is not a new language to the platform — the
  dashboard is already TS — but it is new to the "agent/tools" tier.
- The "a TS agent can't integrate" objection is weak: the platform already has a
  first-class TS→daemon path (the dashboard's ConnectRPC-over-SPIFFE-mTLS), reused
  here (ADR-0004).
- Extensibility spans two surfaces: opencode's TS plugin ecosystem **and**
  Gibson's polyglot component model (any language via gRPC/MCP).
