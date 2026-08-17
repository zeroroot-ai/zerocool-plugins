import {
  componentKnowledge,
  connectTaskHarness,
  taskKnowledge,
  type GibsonSession,
  type KnowledgeSource,
} from "@zeroroot-ai/sdk"

/**
 * Pick the grant this process should read the knowledge graph with.
 *
 * A DISPATCHED run must read as the TASK, not as the component. gibson mints a
 * per-dispatch capability grant and `zerocool-agent` passes it to the child as
 * GIBSON_CALLBACK_ENDPOINT / GIBSON_CALLBACK_TOKEN. Reading with the component's
 * own grant instead is broader authority than the dispatch intended and leaves
 * no per-task attribution on anything the run reads — the gap ADR-0006 recorded.
 *
 * An INTERACTIVE run has no callback seam and keeps the component grant, which
 * is correct: a human started it, and there is no task to scope to.
 *
 * A dispatch that carries an endpoint but no token FAILS rather than falling
 * back. Falling back is how the gap reappears silently, and a caller who wanted
 * task-scoped reads would get component-scoped ones without being told.
 */
export function selectKnowledgeSource(session: GibsonSession): {
  knowledge: KnowledgeSource
  scope: "task" | "component"
} {
  const endpoint = process.env.GIBSON_CALLBACK_ENDPOINT
  const token = process.env.GIBSON_CALLBACK_TOKEN

  if (!endpoint) {
    return { knowledge: componentKnowledge(session.clients.component), scope: "component" }
  }
  if (!token) {
    throw new Error(
      "GIBSON_CALLBACK_ENDPOINT is set but GIBSON_CALLBACK_TOKEN is not. A dispatched run " +
        "must read with its task grant; falling back to the component grant would silently " +
        "widen this run's authority.",
    )
  }
  return {
    knowledge: taskKnowledge(
      connectTaskHarness({
        endpoint,
        token,
        // A local or kind daemon may serve the callback listener without TLS.
        insecure: process.env.GIBSON_CALLBACK_INSECURE === "1",
      }),
    ),
    scope: "task",
  }
}
