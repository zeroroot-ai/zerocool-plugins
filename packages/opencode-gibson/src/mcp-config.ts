// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * How opencode reaches the Gibson MCP server (ADR-0158, slice A7).
 *
 * opencode spawns a local MCP server from its `mcp` block, the same way every
 * other host does from its own config file. The plugin writes that entry in
 * the `config` hook, so a user configures nothing.
 *
 * The command is the published package, not a path inside this plugin: the
 * server is shared by every host and released on the SDK train.
 *
 * The version is exact. `npx --yes` runs whatever the registry serves with no
 * prompt, so a floating tag would run one compromised publish on every
 * machine at session start. The pin is the one in tools/hosts/package.json,
 * which Dependabot bumps. `pins.test.ts` in claude-gibson fails when the two
 * differ or when any install path floats again.
 *
 * The agent image carries no npm at all: every npm release bundles its own
 * copies of undici and ip-address, and an image that carries npm carries
 * their CVEs (zerocool-plugins#101). There the server is installed at build
 * time from tools/opencode/package-lock.json, hash pinned, and
 * `ZEROCOOL_MCP_BIN` names it, the same knob the Claude member driver reads.
 */
export const GIBSON_MCP_PACKAGE = "@zeroroot-ai/gibson-mcp@0.3.0"

/** The command opencode spawns: the installed bin when the image names one, else the pinned package through npx. */
export function gibsonMcpCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const bin = env.ZEROCOOL_MCP_BIN
  if (bin) return [bin, "--transport", "stdio"]
  return ["npx", "--yes", "--package", GIBSON_MCP_PACKAGE, "gibson-mcp", "--transport", "stdio"]
}

export interface OpencodeMcpLocal {
  type: "local"
  command: string[]
  enabled: boolean
  environment?: Record<string, string>
}

/** The `mcp.gibson` entry. `environment` carries nothing secret. */
export function gibsonMcpServer(env: NodeJS.ProcessEnv = process.env): OpencodeMcpLocal {
  const environment: Record<string, string> = {}
  // Addressing only. The server does its own check-in, and a grant is never
  // written into a config file.
  for (const name of ["GIBSON_PLATFORM_URL", "GIBSON_DAEMON_URL", "GIBSON_TARGET_ID", "GIBSON_CA_CERT"]) {
    const value = env[name]
    if (value) environment[name] = value
  }
  return {
    type: "local",
    command: gibsonMcpCommand(env),
    enabled: true,
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  }
}
