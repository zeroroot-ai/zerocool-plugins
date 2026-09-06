// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { createClient, type Client } from "@connectrpc/connect"
import { createGrpcTransport } from "@connectrpc/connect-node"
import { grantInterceptor } from "@zeroroot-ai/sdk"
import { ComponentService } from "@zeroroot-ai/sdk"
import { MemberState as WireMemberState, type MemberStatus as WireMemberStatus } from "@zeroroot-ai/sdk/gen/gibson/bank/v1/bank_pb.js"
import type { MemberState, MemberStatus, StatusReporter } from "./inbox.js"

/**
 * The member heartbeat (glossary, Member status; zerocool-plugins#105).
 *
 * `gibson.component.v1.HeartbeatRequest` carries `MemberStatus`, so the bank
 * learns what each member is doing from the heartbeat it already sends. The
 * daemon decides `DEAD` when the heartbeats stop; a member never reports it.
 *
 * The member authenticates with its base grant, the same credential the
 * inbox uses. It never enrolls and never mints an identity (ADR-0045).
 */
export function wireMemberState(state: MemberState): WireMemberState {
  switch (state) {
    case "launching":
      return WireMemberState.LAUNCHING
    case "needs_sign_in":
      return WireMemberState.NEEDS_SIGN_IN
    case "busy":
      return WireMemberState.BUSY
    case "draining":
      return WireMemberState.DRAINING
    case "dead":
      return WireMemberState.DEAD
    default:
      return WireMemberState.IDLE
  }
}

/** The status as the wire message. */
export function memberStatusMessage(status: MemberStatus): WireMemberStatus {
  return {
    $typeName: "gibson.bank.v1.MemberStatus",
    state: wireMemberState(status.state),
    jobsInFlight: status.jobsInFlight,
    cap: status.cap,
    activeJobIds: [...status.jobs],
    claudeVersion: status.claudeCodeVersion,
  }
}

/**
 * `MemberStatus` has no field for an expiring subscription login, and the
 * person still has to act on it, so it rides on the health message.
 */
export function healthMessage(status: MemberStatus): string {
  if (status.state === "needs_sign_in") return "waiting for a person to sign in"
  if (status.signInExpiresInDays >= 0) return `sign-in expires in ${status.signInExpiresInDays} days`
  return `${status.jobsInFlight} of ${status.cap} jobs in flight`
}

export interface ComponentHeartbeatOptions {
  component: Client<typeof ComponentService>
  /** The instance the daemon knows this member by. */
  instanceId: string
  log?: (line: string) => void
}

export class ComponentHeartbeat implements StatusReporter {
  private readonly log: (line: string) => void

  constructor(private readonly opts: ComponentHeartbeatOptions) {
    this.log = opts.log ?? (() => {})
  }

  async reportStatus(status: MemberStatus): Promise<void> {
    await this.opts.component.heartbeat({
      instanceId: this.opts.instanceId,
      healthStatus: status.state === "dead" ? "unhealthy" : "healthy",
      healthMessage: healthMessage(status),
      member: memberStatusMessage(status),
    })
  }
}

/**
 * A `ComponentService` client on the member base grant.
 *
 * Native gRPC, not the Connect protocol: the daemon's public surface is gRPC
 * behind Envoy, and Envoy carries no grpc_web filter, so a Connect request
 * comes back 415 after passing authentication. Ext-authz reads the grant from
 * the `x-capability-grant` header, which `grantInterceptor` sets.
 */
export function openComponentClient(platformURL: string, token: () => string): Client<typeof ComponentService> {
  return createClient(
    ComponentService,
    createGrpcTransport({ baseUrl: platformURL.replace(/\/+$/, ""), interceptors: [grantInterceptor(token)] }),
  )
}
