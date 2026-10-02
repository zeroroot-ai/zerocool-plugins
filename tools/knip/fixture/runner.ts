// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { usedHelper } from "./helper.js"

/** Imported by nothing. The selftest requires knip to report this. */
export function unusedRunner(): string {
  return usedHelper()
}

/** Imported by nothing. The selftest requires knip to report this too. */
export interface UnusedOptions {
  cwd: string
}
