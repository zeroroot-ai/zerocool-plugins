// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import {
  componentKnowledge,
  openTaskHarness,
  taskKnowledge,
  type GibsonSession,
  type KnowledgeSource,
  type OpenTaskHarnessOptions,
  type TaskHarness,
} from "@zeroroot-ai/sdk"

/** The chosen knowledge source, and the way to release what it opened. */
export interface SelectedKnowledge {
  knowledge: KnowledgeSource
  scope: "task" | "component"
  /**
   * The task harness of a dispatched run. The model path resolves its slot on
   * it, so the run opens one harness and renews one grant. Unset for a
   * component-scoped run, which has no task grant.
   */
  harness?: TaskHarness
  /**
   * Release the task harness. Safe to call on either scope, and safe to call
   * twice. A component-scoped run opens nothing, so this does nothing.
   */
  stop: () => void
}

/** Seams, so a test can read what a dispatched run actually sends. */
export interface KnowledgeSourceDeps {
  /** Opens the task harness. Defaults to `openTaskHarness` on the dispatch grant. */
  openHarness?: (opts: OpenTaskHarnessOptions) => TaskHarness
}

/**
 * Pick the grant this process should read the knowledge graph with.
 *
 * A DISPATCHED run must read as the TASK, not as the component. gibson mints a
 * per-dispatch capability grant, and the driver passes it to this opencode
 * child as GIBSON_CALLBACK_ENDPOINT / GIBSON_CALLBACK_TOKEN. Reading with the
 * component's own grant instead is broader authority than the dispatch
 * intended and leaves no per-task attribution on anything the run reads — the
 * gap ADR-0156 recorded.
 *
 * THESE TWO NAMES ARE THE CHILD CONTRACT, NOT THE LAUNCHER CONTRACT. The
 * launcher writes GIBSON_CG_JWT and GIBSON_AGENT_TASK_B64 into the sandbox,
 * and `readSandboxDispatch` in `@zeroroot-ai/sdk` is the one reader of those
 * (see `dispatch.ts`). This module runs one process further down, inside
 * opencode, whose environment `dispatchChildEnv` writes. It never sees the
 * launch environment, so it reads the child names and nothing else.
 *
 * An INTERACTIVE run has no callback seam and keeps the component grant, which
 * is correct: a human started it, and there is no task to scope to.
 *
 * A dispatch that carries an endpoint but no token FAILS rather than falling
 * back. Falling back is how the gap reappears silently, and a caller who wanted
 * task-scoped reads would get component-scoped ones without being told.
 *
 * `openTaskHarness` derives the `ContextInfo` every callback RPC carries from
 * the grant's own claims, so a task-scoped read reaches the daemon naming the
 * mission it belongs to. It also renews the grant on a timer, which is why the
 * caller must {@link SelectedKnowledge.stop} the source when the session ends.
 */
export function selectKnowledgeSource(
  session: GibsonSession,
  deps: KnowledgeSourceDeps = {},
): SelectedKnowledge {
  if (!process.env.GIBSON_CALLBACK_ENDPOINT) {
    return {
      knowledge: componentKnowledge(session.clients.component),
      scope: "component",
      stop: () => {},
    }
  }
  return openTaskRun(process.env, deps)
}

/**
 * Open the task harness of a granted run from the `GIBSON_CALLBACK_*`
 * variables, and read knowledge through it. It needs no component check-in:
 * no platform URL, no host key and no bootstrap token. A sandboxed run has
 * none of them, and the grant is its only credential.
 *
 * It fails when only one of the endpoint and the token is set. A half-set
 * pair is a defect in the launch, and a fallback would widen the authority of
 * the run.
 */
export function openTaskRun(
  env: NodeJS.ProcessEnv,
  deps: KnowledgeSourceDeps = {},
): SelectedKnowledge & { harness: TaskHarness } {
  const endpoint = env.GIBSON_CALLBACK_ENDPOINT
  const token = env.GIBSON_CALLBACK_TOKEN
  if (!endpoint || !token) {
    throw new Error(
      "GIBSON_CALLBACK_ENDPOINT and GIBSON_CALLBACK_TOKEN must both be set. A dispatched run " +
        "must read with its task grant; falling back to the component grant would silently " +
        "widen this run's authority.",
    )
  }
  const harness = (deps.openHarness ?? openTaskHarness)({
    endpoint,
    token,
    // A local or kind daemon may serve the callback listener without TLS.
    insecure: env.GIBSON_CALLBACK_INSECURE === "1",
  })
  return {
    knowledge: taskKnowledge(harness),
    scope: "task",
    harness,
    stop: () => harness.stop(),
  }
}
