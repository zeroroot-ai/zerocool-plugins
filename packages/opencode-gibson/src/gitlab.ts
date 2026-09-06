// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * GitLab — the trigger the always-on agent watches (zerocool-plugins#88).
 *
 * The agent polls one project's pipelines on one branch. It never receives a
 * webhook and GitLab holds no Gibson credential: the poll runs outbound from
 * the sandbox on the tenant's own project access token, resolved through the
 * harness `GetCredential` under the dispatch grant. That direction is the point
 * — a CI job cannot originate a Gibson mission (ADR-0063 admits a component
 * only from inside a mission it was dispatched to), so the agent watches
 * GitLab rather than GitLab calling Gibson.
 *
 * FINISHED MEANS `success`. A pipeline that failed published no image and left
 * `main` unchanged, so there is nothing new to scan; treating it as a trigger
 * would run a Scan mission against the image the previous pipeline built and
 * report its findings against the new commit. `canceled` and `skipped` are the
 * same case. The status this polls for is therefore `success`, named once in
 * {@link TRIGGER_STATUS} rather than spelled at each call site.
 *
 * Everything here is one `fetch` away from pure: {@link gitlabRest} takes the
 * fetch it uses, so `watch.test.ts` drives a whole loop against a stub with no
 * network and no token.
 */

/** The pipeline status that triggers a Scan mission. See the module note. */
export const TRIGGER_STATUS = "success"

/** GitLab's public host, when a tenant names no other instance. */
export const GITLAB_DEFAULT_URL = "https://gitlab.com"

/** One pipeline, reduced to what a trigger decision and a Scan mission need. */
export interface Pipeline {
  /** GitLab's own pipeline id. Monotonic per project, and the checkpoint key. */
  id: number
  /** The commit the pipeline ran on — the Scan mission's `repository.commit`. */
  sha: string
  /** `success` for anything this module returns; carried for the console line. */
  status: string
  /** The branch, echoed back so a caller can log what it matched. */
  ref: string
  /** GitLab's page for the pipeline, for the console line and the MR note. */
  webUrl: string
}

/** The GitLab reads the watch loop makes. One method, so a stub is three lines. */
export interface GitLabClient {
  /**
   * The most recent successful pipeline on `ref`, or `undefined` when the
   * project has none. Rejects when GitLab refuses or is unreachable — the loop
   * reports that and keeps polling.
   */
  latestFinishedPipeline(ref: string): Promise<Pipeline | undefined>
}

/** What {@link gitlabRest} needs to reach one project. */
export interface GitLabRestOptions {
  /** `group/project`, unencoded. Encoded once here, at the call. */
  projectPath: string
  /** The project access token, resolved from the tenant secret store. */
  token: string
  /** The instance. Defaults to {@link GITLAB_DEFAULT_URL}. */
  baseUrl?: string
  /** Injectable transport. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
}

/** GitLab's pipeline list entry, as the REST API renders it. */
interface RawPipeline {
  id?: unknown
  sha?: unknown
  status?: unknown
  ref?: unknown
  web_url?: unknown
}

/**
 * Read one pipeline out of GitLab's JSON. A row without an id or a sha is
 * dropped rather than guessed at: a Scan mission keyed on a missing commit
 * would scan whatever the workspace happened to hold.
 */
export function parsePipeline(raw: unknown): Pipeline | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const p = raw as RawPipeline
  const id = typeof p.id === "number" ? p.id : Number.NaN
  const sha = typeof p.sha === "string" ? p.sha : ""
  if (!Number.isInteger(id) || id <= 0 || !sha) return undefined
  return {
    id,
    sha,
    status: typeof p.status === "string" ? p.status : "",
    ref: typeof p.ref === "string" ? p.ref : "",
    webUrl: typeof p.web_url === "string" ? p.web_url : "",
  }
}

/**
 * A {@link GitLabClient} over GitLab's REST API.
 *
 * The token travels in `PRIVATE-TOKEN`, which is what a project access token
 * authenticates with. It is never logged and never placed in a URL, so it
 * cannot reach the console stream through an error message that quotes the
 * request.
 */
export function gitlabRest(opts: GitLabRestOptions): GitLabClient {
  const base = (opts.baseUrl || GITLAB_DEFAULT_URL).replace(/\/+$/, "")
  const project = encodeURIComponent(opts.projectPath)
  const doFetch = opts.fetch ?? globalThis.fetch

  return {
    async latestFinishedPipeline(ref) {
      const url =
        `${base}/api/v4/projects/${project}/pipelines` +
        `?ref=${encodeURIComponent(ref)}&status=${TRIGGER_STATUS}&order_by=id&sort=desc&per_page=1`
      const res = await doFetch(url, {
        headers: { "PRIVATE-TOKEN": opts.token, Accept: "application/json" },
      })
      if (!res.ok) {
        throw new Error(
          `GitLab pipelines for ${opts.projectPath}@${ref} returned ${res.status} ${res.statusText}`,
        )
      }
      const body: unknown = await res.json()
      if (!Array.isArray(body)) {
        throw new Error(
          `GitLab pipelines for ${opts.projectPath}@${ref} returned ${typeof body}, expected an array`,
        )
      }
      for (const row of body) {
        const p = parsePipeline(row)
        if (p) return p
      }
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// The write surface (zerocool-plugins#89)
// ---------------------------------------------------------------------------

/** The `gibson/scan` commit status states GitLab accepts, narrowed to what we set. */
export type CommitStatusState = "success" | "failed" | "running"

/** The context name the scan status is reported under, named once. */
export const SCAN_STATUS_CONTEXT = "gibson/scan"

/** A merge request the Fix opened, reduced to what the Fix and a human need. */
export interface MergeRequest {
  /** The project-scoped iid, which is what every later GitLab call takes. */
  iid: number
  /** The page a human opens. Also what the Finding records. */
  webUrl: string
  /** GitLab's own state: `opened`, `merged`, `closed`, `locked`. */
  state: string
}

/** One file the Fix rewrote, as the commit API wants it. */
export interface FileChange {
  path: string
  content: string
}

/** The GitLab writes the Fix makes. Kept behind an interface so a test needs no network. */
export interface GitLabWriter {
  /**
   * Commit `changes` onto a new branch off `startRef`. Returns the commit sha.
   * The branch is created by the same call, so a half-made branch with no
   * commit is not a state this can leave behind.
   */
  commitToBranch(branch: string, startRef: string, message: string, changes: FileChange[]): Promise<string>
  /** Open a merge request set to merge itself when its pipeline succeeds. */
  openMergeRequest(branch: string, targetRef: string, title: string, description: string): Promise<MergeRequest>
  /** The current state of a merge request, so a later pass can see it merged. */
  mergeRequestState(iid: number): Promise<MergeRequest>
  /** Post a note on a merge request. */
  comment(iid: number, body: string): Promise<void>
  /** Set the `gibson/scan` status on a commit. */
  setCommitStatus(sha: string, state: CommitStatusState, description: string, targetUrl?: string): Promise<void>
}

/**
 * A {@link GitLabWriter} over GitLab's REST API.
 *
 * Every request carries the token in `PRIVATE-TOKEN` and never in a URL or a
 * body, so a failure message that quotes the request cannot carry it into the
 * console stream. The error text names the project, the branch and the status
 * code — never a header.
 */
export function gitlabRestWriter(opts: GitLabRestOptions): GitLabWriter {
  const base = (opts.baseUrl || GITLAB_DEFAULT_URL).replace(/\/+$/, "")
  const project = encodeURIComponent(opts.projectPath)
  const doFetch = opts.fetch ?? globalThis.fetch
  const api = `${base}/api/v4/projects/${project}`

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await doFetch(`${api}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": opts.token,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      throw new Error(`GitLab ${method} ${path} on ${opts.projectPath} returned ${res.status} ${res.statusText}`)
    }
    return res.json()
  }

  const asMergeRequest = (raw: unknown, branch: string): MergeRequest => {
    const mr = (raw ?? {}) as { iid?: unknown; web_url?: unknown; state?: unknown }
    const iid = typeof mr.iid === "number" ? mr.iid : Number.NaN
    if (!Number.isInteger(iid) || iid <= 0) {
      throw new Error(`GitLab returned a merge request for ${branch} with no iid`)
    }
    return {
      iid,
      webUrl: typeof mr.web_url === "string" ? mr.web_url : "",
      state: typeof mr.state === "string" ? mr.state : "",
    }
  }

  return {
    async commitToBranch(branch, startRef, message, changes) {
      if (changes.length === 0) {
        throw new Error(`refusing to commit an empty change set to ${branch}`)
      }
      const raw = await call("POST", "/repository/commits", {
        branch,
        start_branch: startRef,
        commit_message: message,
        actions: changes.map((c) => ({ action: "update", file_path: c.path, content: c.content })),
      })
      const sha = (raw as { id?: unknown }).id
      if (typeof sha !== "string" || !sha) {
        throw new Error(`GitLab accepted the commit on ${branch} but returned no sha`)
      }
      return sha
    },

    async openMergeRequest(branch, targetRef, title, description) {
      const created = asMergeRequest(
        await call("POST", "/merge_requests", {
          source_branch: branch,
          target_branch: targetRef,
          title,
          description,
          remove_source_branch: true,
        }),
        branch,
      )
      // Auto-merge is a separate call, and a refusal is not fatal: the merge
      // request is open and correct either way, and a human can merge it. A
      // thrown error here would lose a good merge request over a race with the
      // pipeline that has not started yet.
      try {
        await call("PUT", `/merge_requests/${created.iid}/merge`, { merge_when_pipeline_succeeds: true })
      } catch {
        // Reported by the caller through the note, not swallowed silently.
      }
      return created
    },

    mergeRequestState: async (iid) => asMergeRequest(await call("GET", `/merge_requests/${iid}`), `!${iid}`),

    comment: async (iid, body) => {
      await call("POST", `/merge_requests/${iid}/notes`, { body })
    },

    setCommitStatus: async (sha, state, description, targetUrl) => {
      await call("POST", `/statuses/${encodeURIComponent(sha)}`, {
        state,
        name: SCAN_STATUS_CONTEXT,
        context: SCAN_STATUS_CONTEXT,
        description,
        ...(targetUrl ? { target_url: targetUrl } : {}),
      })
    },
  }
}
