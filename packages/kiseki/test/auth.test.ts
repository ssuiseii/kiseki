import { describe, expect, test } from "bun:test"
import {
  authenticate,
  buildKeyIndex,
  extractCredentials,
  type AuthConfig,
  type Credentials,
} from "../src/server/auth"

/**
 * Auth (design.md §16, decisions #29–33).
 *
 * These are unit tests over the decision function, plus the extraction that feeds
 * it. The HTTP ordering rule ("401 before 404") is a server concern and is tested
 * there; here we pin the two channels, the shared allowlist and the refused
 * query parameter.
 */

const config: AuthConfig = {
  methods: ["path", "bearer"],
  keys: [
    { token: "client-main", label: "main" },
    { token: "client-indexer", label: "indexer" },
  ],
}

const credentials = (overrides: Partial<Credentials> = {}): Credentials => ({ ...overrides })

describe("two channels, one allowlist (§16.1, #31)", () => {
  test("a path key is accepted and yields its label", () => {
    const result = authenticate(credentials({ pathKey: "client-main" }), config)
    expect(result).toEqual({ ok: true, label: "main", channel: "path" })
  })

  test("a Bearer token is accepted and yields the same label", () => {
    const result = authenticate(credentials({ bearer: "client-main" }), config)
    expect(result).toEqual({ ok: true, label: "main", channel: "bearer" })
  })

  test("the second key is a peer, not a subordinate", () => {
    expect(authenticate(credentials({ pathKey: "client-indexer" }), config)).toEqual({
      ok: true,
      label: "indexer",
      channel: "path",
    })
  })

  test("path key and Bearer may both be present; one match is enough", () => {
    const result = authenticate(
      credentials({ pathKey: "client-main", bearer: "client-indexer" }),
      config,
    )
    expect(result).toEqual({ ok: true, label: "main", channel: "path" })
  })

  test("a valid Bearer rescues an invalid path key", () => {
    // §16.1: "cukup salah satu cocok untuk lolos".
    const result = authenticate(
      credentials({ pathKey: "wrong", bearer: "client-main" }),
      config,
    )
    expect(result).toEqual({ ok: true, label: "main", channel: "bearer" })
  })

  test("both wrong is a failure, reported as unknown", () => {
    expect(authenticate(credentials({ pathKey: "x", bearer: "y" }), config)).toEqual({
      ok: false,
      reason: "unknown",
    })
  })
})

describe("nothing presented vs something wrong", () => {
  test("no credentials at all is `missing`", () => {
    expect(authenticate(credentials(), config)).toEqual({ ok: false, reason: "missing" })
  })

  test("an empty path key counts as absent, not as a wrong key (§16.3)", () => {
    const extracted = extractCredentials({ keySegments: [""], authorization: null })
    expect(extracted.pathKey).toBeUndefined()
    expect(authenticate(extracted, config)).toEqual({ ok: false, reason: "missing" })
  })
})

describe("channel configuration", () => {
  const bearerOnly: AuthConfig = { methods: ["bearer"], keys: config.keys }
  const pathOnly: AuthConfig = { methods: ["path"], keys: config.keys }

  test("a disabled channel does not accept its key", () => {
    // Presenting a valid token on a channel the operator turned off must not be a
    // silent bypass.
    expect(authenticate(credentials({ pathKey: "client-main" }), bearerOnly)).toEqual({
      ok: false,
      reason: "unknown",
    })
  })

  test("the enabled channel still works when the other is off", () => {
    expect(authenticate(credentials({ bearer: "client-main" }), bearerOnly)).toEqual({
      ok: true,
      label: "main",
      channel: "bearer",
    })
    expect(authenticate(credentials({ pathKey: "client-main" }), pathOnly)).toEqual({
      ok: true,
      label: "main",
      channel: "path",
    })
  })

  test("with both channels disabled, anything presented is `channel-disabled`", () => {
    const none: AuthConfig = { methods: [], keys: config.keys }
    expect(authenticate(credentials({ bearer: "client-main" }), none)).toEqual({
      ok: false,
      reason: "channel-disabled",
    })
  })
})

describe("query parameter is refused (#32)", () => {
  test("?apikey= is rejected even when it holds a valid token", () => {
    expect(authenticate(credentials({ queryKey: "client-main" }), config)).toEqual({
      ok: false,
      reason: "query-param",
    })
  })

  test("?apikey= is rejected even when a valid path key is also present", () => {
    // The surface is exactly two channels; a request that tries a third is not
    // half-honoured.
    expect(
      authenticate(credentials({ pathKey: "client-main", queryKey: "client-main" }), config),
    ).toEqual({ ok: false, reason: "query-param" })
  })
})

describe("credential extraction", () => {
  test("a Bearer header is parsed case-insensitively", () => {
    expect(extractCredentials({ keySegments: [], authorization: "bearer client-main" }).bearer).toBe(
      "client-main",
    )
    expect(extractCredentials({ keySegments: [], authorization: "BEARER client-main" }).bearer).toBe(
      "client-main",
    )
  })

  test("a non-Bearer Authorization header is ignored, not treated as a key", () => {
    expect(
      extractCredentials({ keySegments: [], authorization: "Basic dXNlcjpwYXNz" }).bearer,
    ).toBeUndefined()
  })

  test("an empty Authorization header is absent", () => {
    expect(extractCredentials({ keySegments: [], authorization: "" }).bearer).toBeUndefined()
    expect(extractCredentials({ keySegments: [], authorization: null }).bearer).toBeUndefined()
  })

  test("the first non-empty path segment is the key", () => {
    expect(extractCredentials({ keySegments: ["", "client-main"], authorization: null }).pathKey).toBe(
      "client-main",
    )
  })

  test("an apikey query parameter is surfaced so it can be refused", () => {
    const extracted = extractCredentials({
      keySegments: [],
      authorization: null,
      query: new URLSearchParams("apikey=client-main"),
    })
    expect(extracted.queryKey).toBe("client-main")
  })
})

describe("the index never stores a raw token as a key", () => {
  test("lookup is by digest, and the label is what comes back", () => {
    const index = buildKeyIndex(config.keys)
    expect([...index.values()].sort()).toEqual(["indexer", "main"])
    for (const key of index.keys()) {
      expect(key).not.toContain("client-main")
      expect(key).not.toContain("client-indexer")
    }
  })

  test("an empty token in config is not indexed (it could never be presented)", () => {
    const index = buildKeyIndex([{ token: "", label: "ghost" }])
    expect(index.size).toBe(0)
  })
})
