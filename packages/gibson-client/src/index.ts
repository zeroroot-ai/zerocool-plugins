// @zerocool/gibson-client — typed access to the Gibson daemon.
//
// connect-es bindings are generated from BSR (buf.build/zeroroot-ai-platform/sdk)
// under ./gen. Capability Grant auth (host/agent keys, agent+jwt) lands in a
// follow-up (zerocool#3) and plugs in as a Connect interceptor on the transport.
import { createClient, type Client, type Transport } from "@connectrpc/connect"
import { ComponentService } from "./gen/gibson/component/v1/component_pb.js"
import { HarnessCallbackService } from "./gen/gibson/harness/v1/harness_callback_pb.js"

export { ComponentService, HarnessCallbackService }

export interface GibsonClients {
  /** ComponentService: register/heartbeat/poll, plus the LLM/tool/finding proxy RPCs. */
  component: Client<typeof ComponentService>
  /** HarnessCallbackService: the dispatched-component callback surface. */
  harness: Client<typeof HarnessCallbackService>
}

/** Build typed Gibson clients over any Connect transport. */
export function createGibsonClients(transport: Transport): GibsonClients {
  return {
    component: createClient(ComponentService, transport),
    harness: createClient(HarnessCallbackService, transport),
  }
}
