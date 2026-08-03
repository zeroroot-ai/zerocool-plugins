# zerocool-plugins

**Zerocool is a collection of opencode plugins for Gibson interoperability.**
Install a plugin, and opencode gains Gibson: LLM through the harness, tools,
findings, the knowledge graph, delegation/missions — with a bootstrap key.

## Three layers (all branded zerocool)

1. **`@zerocool/sdk`** (repo [`sdk-ts`](https://github.com/zeroroot-ai/sdk-ts)) — the
   framework-agnostic TS Gibson SDK: connect-es bindings (BSR), Capability Grant
   auth, component register/heartbeat, the session singleton, the OpenAI-compat
   shim. Nothing opencode-specific. Any TS program can use it.
2. **`zerocool-plugins`** (this repo) — the opencode plugins that import the SDK.
3. **`zerocool`** (later) — a branded opencode **fork** that *inserts* these plugins
   and carries any **core** patches for the one thing a plugin cannot do (#14).

## The collection

| Package | What | Adoption |
|---|---|---|
| **`@zerocool/opencode-gibson`** (main) | session check-in (Capability Grant + RegisterComponent + heartbeat), **zero-config LLM** (a `config` hook adds `provider.gibson` pointing at the SDK shim), Gibson tools, findings (`event`→Emit), knowledge (`system.transform`/recall tool), delegate/missions | one install, most value |
| **`@zerocool/opencode-gibson-exec`** (opt-in) | route execution into the setec **Devbox** via `experimental_workspace.register` (#12) | invasive — changes where code runs |
| **`@zerocool/opencode-gibson-sessions`** (opt-in) | mirror local context to the daemon store via events (#13) | invasive — changes where state lives |

## Boundary — plugin vs core

The opencode plugin API is rich (`config`, `provider`, `auth`, `tool`, `event`,
`chat.*`/`system.transform`, `permission.ask`, `tool.execute.*`, `shell.env`,
`experimental_workspace`, `dispose`). So **almost everything is a plugin**,
including zero-config LLM and Devbox execution.

**The one thing that is not a plugin: #14 dispatched mode** — an external driver
over opencode's server/SDK (`PollWork` → run opencode headless). Deferred to the
`zerocool` fork.

A shared **Gibson session singleton** lives in `@zerocool/sdk` so multiple plugins
share one Capability-Grant auth + one `RegisterComponent`.

## Open platform-side item

Devbox execution (#12) uses opencode's **remote-workspace** protocol — the Devbox
must run that endpoint. This likely supersedes the `DevboxExec` RPC design in
gibson#1183 (to be re-scoped).
