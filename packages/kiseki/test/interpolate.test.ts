import { describe, expect, test } from "bun:test"
import { interpolate, interpolateTree, referencedVariables } from "../src/config/interpolate"

const env = { TOKEN: "abc123", EMPTY: "", HOST: "rpc.example.com" }

describe("interpolate (§15.1 rule 4)", () => {
  test("substitutes a present variable", () => {
    expect(interpolate("${TOKEN}", env)).toEqual({ ok: true, text: "abc123" })
  })

  test("several references in one string", () => {
    expect(interpolate("https://${HOST}/v2/${TOKEN}", env)).toEqual({
      ok: true,
      text: "https://rpc.example.com/v2/abc123",
    })
  })

  test("a missing variable fails and names only the variable", () => {
    const result = interpolate("${NOPE}", env)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.errors).toEqual(["missing environment variable NOPE (referenced as ${NOPE})"])
  })

  test("an empty variable counts as missing (never send an anonymous key)", () => {
    expect(interpolate("${EMPTY}", env).ok).toBe(false)
  })

  test("${VAR:-fallback} uses the fallback only when unset or empty", () => {
    expect(interpolate("${MISSING:-def}", env)).toEqual({ ok: true, text: "def" })
    expect(interpolate("${EMPTY:-def}", env)).toEqual({ ok: true, text: "def" })
    expect(interpolate("${TOKEN:-def}", env)).toEqual({ ok: true, text: "abc123" })
  })

  test("${VAR:-} allows an explicitly empty fallback", () => {
    expect(interpolate("${MISSING:-}", env)).toEqual({ ok: true, text: "" })
  })

  test("${VAR?hint} reports the hint when missing", () => {
    const result = interpolate("${NOPE?needed for ethereum}", env)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.errors).toEqual(["missing environment variable NOPE: needed for ethereum"])
  })

  test("$${VAR} escapes to a literal reference", () => {
    expect(interpolate("$${TOKEN}", env)).toEqual({ ok: true, text: "${TOKEN}" })
  })

  test("text that is not a reference is untouched", () => {
    expect(interpolate("${}", env)).toEqual({ ok: true, text: "${}" })
    expect(interpolate("${1BAD}", env)).toEqual({ ok: true, text: "${1BAD}" })
    expect(interpolate("$TOKEN", env)).toEqual({ ok: true, text: "$TOKEN" })
  })

  test("every missing reference is reported, not just the first", () => {
    const result = interpolate("${A} ${B}", env)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.errors).toHaveLength(2)
  })
})

describe("interpolateTree", () => {
  test("walks nested objects and arrays, reporting the path", () => {
    const tree = {
      chains: { ethereum: { upstreams: [{ apikeys: [{ token: "${TOKEN}" }] }] } },
      list: ["${HOST}", "plain"],
    }
    const result = interpolateTree(tree, env)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value).toEqual({
      chains: { ethereum: { upstreams: [{ apikeys: [{ token: "abc123" }] }] } },
      list: ["rpc.example.com", "plain"],
    })
  })

  test("a failure carries the exact config path", () => {
    const tree = { chains: { ethereum: { upstreams: [{ url_template: "${NOPE}" }] } } }
    const result = interpolateTree(tree, env)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.errors).toEqual([
      {
        path: "chains.ethereum.upstreams[0].url_template",
        message: "missing environment variable NOPE (referenced as ${NOPE})",
      },
    ])
  })

  test("keys and numbers are left alone", () => {
    const result = interpolateTree({ "${TOKEN}": 1, port: 8545, flag: true, nothing: null }, env)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value).toEqual({ "${TOKEN}": 1, port: 8545, flag: true, nothing: null })
  })
})

describe("referencedVariables", () => {
  test("lists unique names without values", () => {
    expect(referencedVariables("${A} ${B} ${A}")).toEqual(["A", "B"])
  })
})
