/**
 * JSON-RPC 2.0 wire types (design.md §7.1, implementation.md §2).
 *
 * These are the shapes that cross the HTTP boundary in both directions. Nothing
 * here is provider specific.
 */

export type JsonRpcId = string | number | null

export type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcRequest = {
  jsonrpc?: string
  id?: JsonRpcId
  method: string
  params?: unknown[] | Record<string, unknown>
}

/** Success envelope as sent by an upstream node. */
export type JsonRpcSuccess = {
  jsonrpc: "2.0"
  id: JsonRpcId
  result: unknown
}

/** Failure envelope as sent by an upstream node. */
export type JsonRpcFailure = {
  jsonrpc: "2.0"
  id: JsonRpcId
  error: JsonRpcError
}

export type JsonRpcResult = JsonRpcSuccess | JsonRpcFailure

export function isJsonRpcError(value: unknown): value is JsonRpcError {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { code?: unknown; message?: unknown }
  return typeof candidate.code === "number" && typeof candidate.message === "string"
}
