# zerocool-plugins

**Zerocool is a collection of [opencode](https://github.com/sst/opencode) plugins
for [Gibson](https://zeroroot.ai) interoperability.**

Install a plugin and opencode gains Gibson — LLM routed through the harness
(slots, budget, per-tenant creds, tracing), Gibson tools, findings, the knowledge
graph, and delegation/missions.

## Install

Not on npm yet — `npm i @zeroroot-ai/zerocool` does not resolve. One step remains,
and it needs a human.

The packages will publish under the **`@zeroroot-ai`** scope. The earlier
`@zerocool` scope was never claimable: it needed an npm org created by hand, which
is what kept [#26](https://github.com/zeroroot-ai/zerocool-plugins/issues/26)
blocked. `@zeroroot-ai` is the account's own username scope, so it needs no org
and is writable already — **the scope is no longer the blocker**.

What remains is the publishing credential. The account enforces 2FA, so the
release job fails with:

```
npm error 403 Two-factor authentication or granular access token with
bypass 2fa enabled is required to publish packages.
```

The fix is an npm **granular access token with "bypass 2FA" enabled**, stored as
the `NPM_TOKEN` secret. Until then releases still cut tags and the publish job
warns and skips.

Meanwhile the plugins depend on
[`@zeroroot-ai/sdk`](https://github.com/zeroroot-ai/sdk-ts) by **git tag**. That
installs for anyone — `sdk-ts` is public — but a consumer builds it from source
and cannot express a version range. Moving to a semver range is the last step of
#26, and it lands the moment the SDK is on npm.

To work on the plugins rather than consume them: `pnpm install && pnpm build`,
then point opencode at `packages/opencode-gibson`.

## Packages

- **`@zeroroot-ai/zerocool`** — the main plugin. Zero-config LLM via Gibson,
  tools, findings, knowledge, delegate/missions.
- **`@zeroroot-ai/zerocool-exec`** (opt-in) — run execution in the setec Devbox.
- **`@zeroroot-ai/zerocool-sessions`** (opt-in) — durable sessions via the daemon store.

All build on **[`@zeroroot-ai/sdk`](https://github.com/zeroroot-ai/sdk-ts)** (the
framework-agnostic TS Gibson SDK).

## Dispatched mode: `zerocool-serve`

`@zeroroot-ai/zerocool` also ships a headless entrypoint, **`zerocool-serve`**
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
