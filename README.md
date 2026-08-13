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

## Dispatched mode: `zerocool-serve`

`@zerocool/opencode-gibson` also ships a headless entrypoint, **`zerocool-serve`**
(`bin` of the package). Instead of a human driving the agent, the daemon does:
the process checks in with the Capability Grant handshake, registers as a
`kind=tool` component, heartbeats, and blocks on `PollWork`. A mission node can
then dispatch work to it — the first served capability is `http_probe` (one GET,
reported as structured facts, body measured and never returned).

```sh
GIBSON_PLATFORM_URL=https://api.example:30443 \
GIBSON_BOOTSTRAP_TOKEN=<one-time enrollment token> \
ZEROCOOL_TOOL_NAME=zerocool-http \
  zerocool-serve
```

The bootstrap token is needed for the first check-in only; the persisted host
key (`~/.zerocool/host.key`) re-registers the host afterwards. Handlers receive
the session's Gibson clients, so a served tool can call LLM, tools, findings and
knowledge through the callback harness during a dispatched run.

See [`CONTEXT.md`](CONTEXT.md) and [`docs/adr/`](docs/adr/).

## License

MIT.
