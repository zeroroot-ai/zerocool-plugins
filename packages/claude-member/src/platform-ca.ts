// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Transport } from "@connectrpc/connect"
import { createGrpcTransport } from "@connectrpc/connect-node"
import { grantInterceptor } from "@zeroroot-ai/sdk"
import { X509Certificate } from "node:crypto"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import tls from "node:tls"

/**
 * The platform CA (zerocool-plugins#73).
 *
 * A self-hosted install fronts its edge with a private CA, and Envoy serves a
 * certificate that chains to it. In-cluster pods mount that CA. A sandbox
 * carries only environment, so the daemon hands the CA over as PEM in
 * `GIBSON_PLATFORM_CA_PEM`. The variable is absent when the edge chains to
 * public roots.
 *
 * At start the driver writes the PEM to `platform-ca.pem` under its state
 * directory, trusts it beside the public roots on every gRPC transport it
 * builds, and hands the file to every child it spawns in `NODE_EXTRA_CA_CERTS`.
 * The children never see the PEM itself: `GIBSON_PLATFORM_CA_PEM` is dropped
 * from their environment with the other `GIBSON_` names.
 *
 * `GIBSON_CALLBACK_INSECURE` is a different thing: plaintext for a local
 * daemon. This is TLS with a private root, verification on.
 */
export const PLATFORM_CA_ENV = "GIBSON_PLATFORM_CA_PEM"
/** The file name under `ZEROCOOL_STATE_DIR`. */
export const PLATFORM_CA_FILE = "platform-ca.pem"
/** Node reads this at start. Set on every child, never on the driver itself. */
export const EXTRA_CA_CERTS_ENV = "NODE_EXTRA_CA_CERTS"

export interface PlatformTrust {
  /** The written PEM, for the children. */
  file: string
  /** The public roots Node trusts, then the platform CA. For the driver's own transports. */
  ca: string[]
}

const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g

/**
 * The certificate blocks of a PEM. Refuses an empty value, a value with no
 * certificate block, a block of another kind (a private key is never a CA),
 * and a certificate block that does not parse.
 */
export function certificateBlocks(pem: string): string[] {
  if (!pem.trim()) throw new Error(`${PLATFORM_CA_ENV} is set but empty. It carries the platform CA as PEM, or it is unset.`)
  const blocks = [...pem.matchAll(BLOCK)]
  if (blocks.length === 0) {
    throw new Error(`${PLATFORM_CA_ENV} is not PEM: no -----BEGIN CERTIFICATE----- block. It carries the platform CA as PEM.`)
  }
  const out: string[] = []
  for (const m of blocks) {
    const [block, kind] = m
    if (kind !== "CERTIFICATE") {
      throw new Error(`${PLATFORM_CA_ENV} carries a ${kind} block. It carries certificates only, never a key.`)
    }
    try {
      new X509Certificate(block)
    } catch (e) {
      throw new Error(`${PLATFORM_CA_ENV} carries a certificate block that does not parse: ${(e as Error).message}`)
    }
    out.push(block)
  }
  return out
}

/** Write the PEM to `<stateDir>/platform-ca.pem`, mode 0600. Returns the path. */
export async function writePlatformCa(pem: string, stateDir: string): Promise<string> {
  const blocks = certificateBlocks(pem)
  await mkdir(stateDir, { recursive: true })
  const file = join(stateDir, PLATFORM_CA_FILE)
  await writeFile(file, `${blocks.join("\n")}\n`, { mode: 0o600 })
  // The mode on writeFile applies to a new file only. The state dir persists
  // across restarts, so an existing file is brought to 0600 as well.
  await chmod(file, 0o600)
  return file
}

/**
 * The platform trust of this run, or nothing when the edge chains to public
 * roots. `tls.getCACertificates("default")` is the set Node trusts on its
 * own: the bundled roots, plus whatever the driver process itself was given.
 * The platform CA is appended to it, never put in its place.
 */
export async function platformTrust(env: NodeJS.ProcessEnv, stateDir: string): Promise<PlatformTrust | undefined> {
  const pem = env[PLATFORM_CA_ENV]
  if (pem === undefined) return undefined
  const file = await writePlatformCa(pem, stateDir)
  return { file, ca: [...tls.getCACertificates("default"), ...certificateBlocks(pem)] }
}

/**
 * The environment every child starts from. The PEM is gone, the file is in
 * `NODE_EXTRA_CA_CERTS`. Without a platform CA the environment is returned as
 * it stands, less the PEM variable, which is then unset anyway.
 */
export function childEnv(env: NodeJS.ProcessEnv, trust: PlatformTrust | undefined): NodeJS.ProcessEnv {
  const { [PLATFORM_CA_ENV]: _pem, ...rest } = env
  return trust ? { ...rest, [EXTRA_CA_CERTS_ENV]: trust.file } : rest
}

/**
 * A native gRPC transport on a grant, trusting the platform CA when there is
 * one. Every platform client the driver builds goes through here, so no
 * transport can miss the CA.
 */
export function platformTransport(baseUrl: string, token: () => string, trust: PlatformTrust | undefined): Transport {
  return createGrpcTransport({
    baseUrl,
    interceptors: [grantInterceptor(token)],
    ...(trust ? { nodeOptions: { ca: trust.ca } } : {}),
  })
}
