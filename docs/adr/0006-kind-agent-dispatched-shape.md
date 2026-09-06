# Zerocool serves `kind=agent` dispatched work

## Status

Accepted (2026-08-15, owner decision on [#33](https://github.com/zeroroot-ai/zerocool-plugins/issues/33);
implemented 2026-08-17). Does **not** supersede
[ADR-0005](0005-plugins-not-a-fork.md) — it exercises the carve-out ADR-0005
already wrote.

## Context

[#14](https://github.com/zeroroot-ai/zerocool-plugins/issues/14) asked for the
control inversion: zerocool running headless, driven by the daemon rather than by
a human, reaching back to the platform for LLM, tools and findings. Its re-scope
block declared dispatched mode "**NOT a plugin**" and deferred the whole thing to
a branded opencode fork.

Two things then changed that premise.

**The platform gap closed.** gibson#1197 / gibson ADR-0011 made all three
component kinds receive dispatched work:

| Kind | Work type | Payload |
|---|---|---|
| `tool` | `execute_proto` | `gibson.tool.v1.ExecuteRequest` |
| `plugin` | `plugin_invoke` | plugin method + params |
| `agent` | `agent_execute` | `gibson.agent.v1.ExecuteRequest` |

Before it, "a component registered as kind=agent enrolled, heartbeated and polled
correctly and was never handed anything" (`implementation.go:1195-1210`). After
it, whether zerocool serves a goal-driven executor is a question about what
zerocool *is*, not about what the platform permits.

**Half of #14 shipped as a plugin anyway.** `zerocool-serve` (#27, #31) is a bin
in this package that polls `PollWork` and answers `execute_proto`. It is
dispatched mode, it is not a fork, and it already exists. The "NOT a plugin"
framing did not survive contact with the code.

What remained was `kind=agent`: decode `gibson.agent.v1.ExecuteRequest`, pursue
the goal, answer with an `ExecuteResponse`.

## Decision

**Zerocool serves `kind=agent` dispatched work, from a bin in this package.**

`zerocool-agent` (`src/serve-agent.ts`) registers as `kind=agent`, polls for
`agent_execute`, and drives `opencode run --format json --auto` once per
dispatched Task. Its counterpart in the SDK is `startAgentWorker`
(sdk-ts#24), which carries the wire contract.

Three consequences follow.

**No fork.** ADR-0005 permits a source fork only for what a plugin provably
cannot express, and reserved layer 3 for a branded distribution. An external
*driver* over opencode's documented CLI is neither. `opencode run` already
exposes `--format json` (NDJSON events), `--dir`, `--session`, `--model` and
`--auto` — every affordance this needs. The branded `zerocool` distribution
remains a separate, later concern; it is not a prerequisite for dispatched
agents, which is what #14's deferral had assumed.

**The driver parses a verified schema.** `parseOpencodeEvents` is written against
bytes captured from a real opencode 1.18.13 run, and the fixture in
`opencode-run.test.ts` is that capture. Parsing is tolerant by design: an
unrecognised event type or a stray non-JSON line is skipped, never fatal, because
opencode is free to add event types and a mission node must not fail because it
did.

**A failed run is answered, never left to time out.** The handler throws;
`startAgentWorker` turns a throw into an in-band `ExecuteResponse.error`. gibson
gates on `e.GetMessage() != "" || e.GetCode() != ""`, so the error carries both.
A goal the agent judges unreachable is different: that is
`RESULT_STATUS_FAILED` with no error object, because an unreachable goal is an
outcome and not a crash.

## Known gap — the callback seam is not yet task-scoped

gibson mints a per-dispatch capability grant and sends it as
`callback_endpoint` + `callback_token`, so that "the remote agent reaches harness
operations using the task-scoped capability grant that dispatchWorkAndWait puts
in the work item's context" (`implementation.go:1205-1210`).

The SDK does not yet use it. `connectGibson` builds one transport with
`cg.authInterceptor()` and hands the same clients to every caller, so a
dispatched run reaches `HarnessCallbackService` **as the component, not as the
task** — broader authority than the dispatch intends, and no per-task
attribution on the calls it makes.

`serve-agent.ts` decodes both fields and passes them to the child as
`GIBSON_CALLBACK_ENDPOINT` / `GIBSON_CALLBACK_TOKEN`. Consuming them in
preference to the host-key grant is the next slice, and it belongs in the SDK
where the transport is built. This is recorded rather than silently accepted: it
is a real authority gap, and it is narrower than the pre-#33 state only because
nothing dispatched to an agent at all before now.

## Consequences

- A mission node can hand a coding task to opencode and get a result back, with
  no human turn — #14's acceptance criterion 3, which Option A could never meet.
- Session continuity is available but not automatic. `opencode`'s own session id
  is returned in the outcome metadata as `opencode_session_id`, and the handler
  passes `context.opencode_session_id` back to `--session` when the dispatch
  supplies it. Nothing yet stores it between dispatches; that is the store seam,
  [#13](https://github.com/zeroroot-ai/zerocool-plugins/issues/13).
- Blocker 6 (session affinity) does not apply to this shape. It is a setec
  microVM concern; `zerocool-agent` is a long-lived host process with its own
  durable workspace, so two dispatches in one session see the same worktree by
  construction.
- `zerocool-serve` (`kind=tool`) stays. The two are different offers — one named
  capability with declared parameters, versus a goal-driven executor — and a
  mission author picks by which one the node needs.
