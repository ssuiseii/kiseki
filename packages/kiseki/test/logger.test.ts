import { describe, expect, test } from "bun:test"
import { collectSecrets, createJsonLogger, debugBodiesEnabled } from "../src/observ/logger"

/**
 * Logging (design.md §18.2).
 *
 * The design states three prohibitions: never log request params, never log an
 * upstream apikey token, never log a client key. The first is a discipline; the
 * last two are enforced mechanically here, because a discipline is exactly what
 * fails during an incident.
 */

const sink = () => {
  const lines: string[] = []
  return {
    lines,
    write: (line: string) => {
      lines.push(line)
    },
    /** Every record, parsed. */
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.join("\n"),
  }
}

describe("JSON shape", () => {
  test("one object per line, with ts/level/msg and the fields", () => {
    const out = sink()
    const logger = createJsonLogger({ write: out.write, now: () => 1_700_000_000_000 })
    logger.warn("capability mismatch", { upstream: "a", cap: "archive" })

    expect(out.lines).toHaveLength(1)
    expect(out.records()[0]).toEqual({
      ts: new Date(1_700_000_000_000).toISOString(),
      level: "warn",
      msg: "capability mismatch",
      upstream: "a",
      cap: "archive",
    })
  })

  test("caller fields cannot forge ts/level/msg", () => {
    const out = sink()
    const logger = createJsonLogger({ write: out.write, now: () => 0 })
    logger.info("real message", { msg: "forged", level: "error", ts: "fake" })
    const record = out.records()[0]!
    expect(record.msg).toBe("real message")
    expect(record.level).toBe("info")
    expect(record.ts).toBe(new Date(0).toISOString())
  })

  test("a field with an undefined value is omitted rather than serialised as null", () => {
    const out = sink()
    const logger = createJsonLogger({ write: out.write, now: () => 0 })
    logger.info("x", { present: 1, absent: undefined })
    const record = out.records()[0]!
    expect(record.present).toBe(1)
    expect("absent" in record).toBe(false)
  })
})

describe("level filtering", () => {
  test("default level is info: debug is dropped", () => {
    const out = sink()
    const logger = createJsonLogger({ write: out.write, now: () => 0 })
    logger.debug("invisible")
    logger.info("visible")
    expect(out.records().map((record) => record.msg)).toEqual(["visible"])
  })

  test("level=debug keeps everything", () => {
    const out = sink()
    const logger = createJsonLogger({ level: "debug", write: out.write, now: () => 0 })
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")
    expect(out.records()).toHaveLength(4)
  })

  test("level=warn drops info and debug", () => {
    const out = sink()
    const logger = createJsonLogger({ level: "warn", write: out.write, now: () => 0 })
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")
    expect(out.records().map((record) => record.msg)).toEqual(["w", "e"])
  })
})

describe("§18.2 — a token can never reach the log", () => {
  const secrets = ["client-main", "alchemy-key-a"]

  test("a field whose value IS a secret is redacted", () => {
    const out = sink()
    const logger = createJsonLogger({ write: out.write, secrets, now: () => 0 })
    logger.warn("bad key", { token: "alchemy-key-a" })
    expect(out.text()).not.toContain("alchemy-key-a")
    expect(out.text()).toContain("[redacted]")
  })

  test("a secret embedded inside a string is redacted in place", () => {
    // The realistic leak is a token inside a URL or a message, not a bare field.
    const out = sink()
    const logger = createJsonLogger({ write: out.write, secrets, now: () => 0 })
    logger.warn("request failed", {
      url: "https://eth-mainnet.g.alchemy.com/v2/alchemy-key-a",
    })
    expect(out.text()).not.toContain("alchemy-key-a")
    expect(out.text()).toContain("https://eth-mainnet.g.alchemy.com/v2/[redacted]")
  })

  test("redaction reaches nested objects and arrays", () => {
    const out = sink()
    const logger = createJsonLogger({ write: out.write, secrets, now: () => 0 })
    logger.warn("nested", {
      outer: { inner: [{ key: "client-main" }] },
    })
    expect(out.text()).not.toContain("client-main")
  })

  test("a message that interpolates a secret is scrubbed too", () => {
    // `msg` is not a caller field, but a caller writes it — so it is scrubbed.
    const out = sink()
    const logger = createJsonLogger({ write: out.write, secrets, now: () => 0 })
    logger.warn("using key client-main")
    expect(out.text()).not.toContain("client-main")
    expect(out.text()).toContain("[redacted]")
  })

  test("an empty secret in the list does not redact everything", () => {
    const out = sink()
    const logger = createJsonLogger({ write: out.write, secrets: [""], now: () => 0 })
    logger.info("ordinary message", { value: "kept" })
    expect(out.text()).toContain("ordinary message")
    expect(out.text()).toContain("kept")
  })

  test("collectSecrets gathers client keys and upstream apikeys, not labels", () => {
    const secrets = collectSecrets({
      server: { auth: { keys: [{ token: "client-main" }, { token: "client-indexer" }] } },
      chains: {
        ethereum: {
          upstreams: [{ apikeys: [{ token: "alchemy-a" }, { token: "ankr-x" }] }],
        },
        base: { upstreams: [{ apikeys: [{ token: "alchemy-a" }] }] },
      },
    })
    expect(secrets.sort()).toEqual(["alchemy-a", "ankr-x", "client-indexer", "client-main"])
  })

  test("collectSecrets ignores empty tokens", () => {
    const secrets = collectSecrets({
      server: { auth: { keys: [{ token: "" }] } },
      chains: { ethereum: { upstreams: [{ apikeys: [{ token: "" }] }] } },
    })
    expect(secrets).toEqual([])
  })
})

describe("§18.2 — request params are not logged", () => {
  test("the logger never receives a body unless the caller passes one", () => {
    // Structural check: the pipeline logs `method` and `cap`, never `params`.
    // This test documents the contract the rest of the code relies on.
    const out = sink()
    const logger = createJsonLogger({ write: out.write, now: () => 0 })
    logger.warn("pre-flight rejected", { chain: "ethereum", method: "trace_block", cap: "method" })
    expect(out.text()).not.toContain("params")
  })

  test("KISEKI_DEBUG_BODIES=1 is the documented opt-in", () => {
    expect(debugBodiesEnabled({})).toBe(false)
    expect(debugBodiesEnabled({ KISEKI_DEBUG_BODIES: "0" })).toBe(false)
    expect(debugBodiesEnabled({ KISEKI_DEBUG_BODIES: "1" })).toBe(true)
  })
})
