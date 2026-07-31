# zerocool

> **Status: design stage.** This repo currently holds the founding design
> (`CONTEXT.md` + `docs/adr/`). No product code has landed yet.

**zerocool** is the curated [Gibson](https://zeroroot.ai) flagship coding agent:
an autonomous red/blue **security-tooling factory**, driven from a CLI. Ask it to
*"build me a fuzzer agent that can attack C binaries"* and it builds, tests, and
ships that tool. It runs **standalone** (bring your own LLM key) and, with a Gibson
key, swaps its backends to gain the full platform — isolated execution, the
knowledge graph, ACLs, budgets, and the agent fleet.

Fully open.

## Built on opencode

zerocool is a hard fork / curated distribution of
[**opencode**](https://github.com/sst/opencode) (SST), MIT-licensed. We keep
opencode's copyright and MIT license, credit it prominently, and stay fully open.
zerocool is **not** affiliated with or endorsed by opencode or SST; the rename is
deliberate (MIT licenses the code, not the name). See
[ADR-0001](docs/adr/0001-fork-opencode-drop-rig.md) for the licensing/attribution
and fork-ethics policy. Posture: **plugin-first** — do as much as possible via
opencode's extension points, hard-fork only what we must.

## Design

- [`CONTEXT.md`](CONTEXT.md) — architecture, seams, two-mode model, build order.
- [`docs/adr/`](docs/adr/) — founding decisions:
  - [0001](docs/adr/0001-fork-opencode-drop-rig.md) — fork opencode, drop rig, fork ethics
  - [0002](docs/adr/0002-standalone-platform-seam-fully-open.md) — standalone↔Platform seam, fully open
  - [0003](docs/adr/0003-sdk-rs-rust-component-sdk.md) — sdk-rs (dropped)
  - [0004](docs/adr/0004-flagship-integration-connectrpc-ts.md) — Gibson integration via TS ConnectRPC

## License

MIT — see [`LICENSE`](LICENSE). opencode's copyright and MIT license are preserved
in the distribution once its code lands.
