# zerocool-plugins

**Zerocool is a collection of [opencode](https://github.com/sst/opencode) plugins
for [Gibson](https://zeroroot.ai) interoperability.**

Install a plugin and opencode gains Gibson — LLM routed through the harness
(slots, budget, per-tenant creds, tracing), Gibson tools, findings, the knowledge
graph, and delegation/missions.

## Packages

- **`@zerocool/opencode-gibson`** — the main plugin. Zero-config LLM via Gibson,
  tools, findings, knowledge, delegate/missions.
- **`@zerocool/opencode-gibson-exec`** (opt-in) — run execution in the setec Devbox.
- **`@zerocool/opencode-gibson-sessions`** (opt-in) — durable sessions via the daemon store.

All build on **[`@zerocool/sdk`](https://github.com/zeroroot-ai/sdk-ts)** (the
framework-agnostic TS Gibson SDK).

See [`CONTEXT.md`](CONTEXT.md) and [`docs/adr/`](docs/adr/).

## License

MIT.
