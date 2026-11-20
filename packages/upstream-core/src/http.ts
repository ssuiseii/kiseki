/**
 * HTTP transport for one attempt: POST a JSON body, get text back, with a
 * per-attempt timeout via `AbortSignal.timeout()` (design.md §14).
 *
 * Kept deliberately dumb — classification lives in `result.ts` so that the
 * taxonomy logic is testable without any network at all.
 */

export type PostJsonOk = {
  kind: "response"
  status: number
  headers: Headers
  text: string
  latencyMs: number
}

/**
 * Transport-level failure. `reachedNode` distinguishes the sendRaw cases
 * (design.md §11.3): a connection that was never established is a clear
 * pre-broadcast failure, while a timeout/reset/5xx is ambiguous.
 */
export type PostJsonFailure = {
  kind: "transport_error"
  reason: "timeout" | "network" | "aborted"
  /** False when we know the request never reached the node (DNS/refused/TLS). */
  reachedNode: boolean
  message: string
  latencyMs: number
}

export type PostJsonResult = PostJsonOk | PostJsonFailure

export type PostJsonOptions = {
  url: string
  body: unknown
  timeoutMs: number
  fetchImpl?: typeof fetch
  now(): number
  /** Extra headers (provider quirks: API keys in headers, etc.). */
  headers?: Record<string, string>
  /** Caller-provided signal (server shutdown); composed with the timeout. */
  signal?: AbortSignal
}

/** Connection-level failures that prove the request never left this process. */
const PRE_BROADCAST_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
])

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const candidate = error as { code?: unknown; cause?: { code?: unknown } }
  if (typeof candidate.code === "string") return candidate.code
  if (typeof candidate.cause?.code === "string") return candidate.cause.code
  return undefined
}

const isTimeout = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return (
    candidate.name === "TimeoutError" ||
    candidate.name === "AbortError" ||
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "UND_ERR_CONNECT_TIMEOUT"
  )
}

export async function postJson(options: PostJsonOptions): Promise<PostJsonResult> {
  const { url, body, timeoutMs, now } = options
  const doFetch = options.fetchImpl ?? fetch
  const startedAt = now()

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([timeoutSignal, options.signal])

  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    return {
      kind: "response",
      status: response.status,
      headers: response.headers,
      text,
      latencyMs: now() - startedAt,
    }
  } catch (error) {
    const code = errorCode(error)
    const timedOut = isTimeout(error)
    const neverReached = code !== undefined && PRE_BROADCAST_CODES.has(code)
    return {
      kind: "transport_error",
      reason: timedOut ? "timeout" : options.signal?.aborted === true ? "aborted" : "network",
      reachedNode: !neverReached,
      message: error instanceof Error ? error.message : String(error),
      latencyMs: now() - startedAt,
    }
  }
}
