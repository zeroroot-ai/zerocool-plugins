// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * Plain string scans for the places that used to hold a regular expression.
 *
 * `/\/+$/` and `/^\/+/` on caller input are polynomial (CodeQL
 * js/polynomial-redos, zerocool-plugins#13): every start position rescans the
 * run of slashes. A loop reads each character once.
 */

/** `s` without its trailing slashes. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--
  return s.slice(0, end)
}

/** `s` without its leading slashes. */
export function trimLeadingSlashes(s: string): string {
  let start = 0
  while (start < s.length && s.charCodeAt(start) === 47) start++
  return s.slice(start)
}
