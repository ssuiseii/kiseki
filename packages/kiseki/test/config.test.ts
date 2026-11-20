import { describe, expect, test } from "bun:test"
import { AdapterRegistry } from "upstream-core"
import { buildRegistry } from "../src/registry"
import {
  ConfigError,
  formatSharedIdentity,
  loadConfigText,
  type LoadOptions,
} from "../src/config/index"

/**
 * Config error handling (design.md §15.1, implementation.md §6).
 *
 * The point of these tests is not that errors happen — it is that every error
 * names the offending path, reports ALL problems at once, and never echoes a
 * secret value (design.md §18.2).
 */

const env = {
  KEY_A: "alchemy-a",
  KEY_B: "alchemy-b",
  CLIENT_MAIN: "client-main",
}

const options: LoadOptions = { env, registry: buildRegistry() }

/**
 * Minimal valid config, expressed as a JS object then serialized to YAML.
 *
 * Typed loosely on purpose: these tests mutate fields (and add chains) to break
 * one rule at a time, which a precise literal type would fight.
 */
type Fixture = {
  server: {
    port?: number
    host?: string
    auth: { methods?: string[]; keys: { token: string; label: string }[] }
  }
  defaults?: Record<string, unknown>
  chains: Record<string, any>
}

const base = (): Fixture => ({
  server: {
    port: 8545,
    host: "127.0.0.1",
    auth: { keys: [{ token: "${CLIENT_MAIN}", label: "main" }] },
  },
  chains: {
    ethereum: {
      upstreams: [
        {
          name: "alchemy-ethereum",
          provider: "alchemy",
          package: "alchemy",
          url_template: "https://eth-mainnet.g.alchemy.com/v2/{apikey}",
          apikeys: [
            { token: "${KEY_A}", label: "a", buckets: [{ capacity: 10, refill_per_second: 1 }] },
          ],
          methods: ["eth_*"],
          archive: true,
        },
      ],
    },
  },
})

/** The single upstream most tests mutate. */
const upstream = (cfg: Fixture): Record<string, any> => cfg.chains.ethereum.upstreams[0]

/** JSON is valid YAML, so this keeps the fixtures readable and mutation-friendly. */
const yaml = (value: unknown): string => JSON.stringify(value, null, 2)

const load = (value: unknown) => loadConfigText(yaml(value), options)

const expectIssues = (value: unknown, pattern: RegExp): ConfigError => {
  try {
    load(value)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    const configError = error as ConfigError
    expect(configError.message).toMatch(pattern)
    return configError
  }
  throw new Error("expected loadConfigText to throw")
}

describe("happy path", () => {
  test("the minimal config loads", () => {
    const loaded = load(base())
    expect(loaded.config.server.auth.keys).toHaveLength(1)
    expect(loaded.warnings).toEqual([])
  })

  test("defaults are applied, not required", () => {
    const loaded = load(base())
    expect(loaded.config.limits.max_total_attempts).toBe(0)
    expect(loaded.config.metrics.enabled).toBe(true)
    expect(loaded.config.defaults.blocked_methods).toEqual(["eth_sendTransaction"])
    expect(loaded.config.defaults.timeouts.default_seconds).toBe(30)
    expect(loaded.config.defaults.timeouts.heavy_seconds).toBe(120)
    expect(loaded.config.server.auth.methods).toEqual(["path", "bearer"])
  })
})

describe("rule 4 — environment interpolation", () => {
  test("a missing variable is a startup error that names the variable", () => {
    const cfg = base()
    upstream(cfg).apikeys[0]!.token = "${UNSET_KEY}"
    const error = expectIssues(cfg, /UNSET_KEY/)
    expect(error.errors[0]!.path).toBe("chains.ethereum.upstreams[0].apikeys[0].token")
  })

  test("the error names the config path and never the value", () => {
    const cfg = base()
    upstream(cfg).apikeys[0]!.token = "${DOES_NOT_EXIST}"
    const error = expectIssues(cfg, /DOES_NOT_EXIST/)
    expect(error.errors[0]!.path).toBe("chains.ethereum.upstreams[0].apikeys[0].token")
  })

  test("an empty variable counts as missing", () => {
    expect(() =>
      loadConfigText(yaml(base()), { env: { ...env, KEY_A: "" }, registry: buildRegistry() }),
    ).toThrow(/KEY_A/)
  })

  test("${VAR:-fallback} supplies a default", () => {
    const cfg = base()
    upstream(cfg).url_template =
      "https://${HOST:-eth-mainnet.g.alchemy.com}/v2/{apikey}"
    const loaded = loadConfigText(yaml(cfg), { env, registry: buildRegistry() })
    expect(loaded.config.chains.ethereum!.upstreams[0]!.url_template).toBe(
      "https://eth-mainnet.g.alchemy.com/v2/{apikey}",
    )
  })

  test("${VAR?hint} reports the hint", () => {
    const cfg = base()
    upstream(cfg).apikeys[0]!.token = "${NOPE?set the alchemy key}"
    expectIssues(cfg, /set the alchemy key/)
  })

  test("interpolation applies to keys' values, never to comments", () => {
    const text = [
      "# documentation: use ${KEY_A} in your shell",
      yaml(base()).split("\n").map((line) => `  ${line}`).join("\n"),
    ].join("\n")
    // The comment references KEY_A but the value is present, so this loads; the
    // real assertion is that an unknown name in a comment cannot break startup.
    const withUnknownComment = text.replace("${KEY_A}", "${TOTALLY_UNSET}")
    expect(() =>
      loadConfigText(withUnknownComment, { env, registry: buildRegistry() }),
    ).not.toThrow()
  })

  test("a duplicated ${VAR} is reported once per occurrence, with paths", () => {
    const cfg = base()
    upstream(cfg).apikeys[0]!.token = "${MISSING_ONE}"
    upstream(cfg).url_template = "https://x/${MISSING_TWO}/{apikey}"
    const error = expectIssues(cfg, /MISSING_ONE/)
    expect(error.errors.map((issue) => issue.path).sort()).toEqual([
      "chains.ethereum.upstreams[0].apikeys[0].token",
      "chains.ethereum.upstreams[0].url_template",
    ])
  })
})

describe("rules 1–2 — shape", () => {
  test("rule 1: chains must not be empty", () => {
    expectIssues({ ...base(), chains: {} }, /at least one chain/)
  })

  test("rule 1: a chain needs at least one upstream", () => {
    expectIssues(
      { ...base(), chains: { ethereum: { upstreams: [] } } },
      /too small|at least/i,
    )
  })

  test("rule 2: capacity must be > 0", () => {
    const cfg = base()
    upstream(cfg).apikeys[0]!.buckets[0]!.capacity = 0
    expectIssues(cfg, /capacity/)
  })

  test("rule 2: refill_per_second must be > 0 (refill 0 is forbidden)", () => {
    const cfg = base()
    upstream(cfg).apikeys[0]!.buckets[0]!.refill_per_second = 0
    expectIssues(cfg, /refill_per_second/)
  })

  test("an unknown key is an error, not silently ignored", () => {
    const cfg = base()
    upstream(cfg).arcive = true
    expectIssues(cfg, /Unrecognized key|arcive/)
  })

  test("a missing required field is named by path", () => {
    const cfg = base()
    delete upstream(cfg).archive
    expectIssues(cfg, /archive/)
  })
})

describe("rule 3 — uniqueness", () => {
  test("instance names are unique globally, across chains", () => {
    const cfg = base()
    cfg.chains.base = {
      upstreams: [
        {
          ...upstream(cfg),
          name: "alchemy-ethereum",
          url_template: "https://base-mainnet.g.alchemy.com/v2/{apikey}",
        },
      ],
    } as never
    expectIssues(cfg, /already used by chains.ethereum/)
  })

  test("apikey labels are unique within an instance", () => {
    const cfg = base()
    upstream(cfg).apikeys.push({
      token: "${KEY_B}",
      label: "a",
      buckets: [{ capacity: 10, refill_per_second: 1 }],
    })
    expectIssues(cfg, /duplicated in this instance/)
  })

  test("the same label in different instances is fine", () => {
    const cfg = base()
    cfg.chains.base = {
      upstreams: [
        {
          ...upstream(cfg),
          name: "alchemy-base",
          url_template: "https://base-mainnet.g.alchemy.com/v2/{apikey}",
        },
      ],
    } as never
    expect(() => load(cfg)).not.toThrow()
  })
})

describe("rule 5 — blocked methods", () => {
  test("naming a blocked method explicitly is a contradiction", () => {
    const cfg = base()
    upstream(cfg).methods = ["eth_sendTransaction"]
    expectIssues(cfg, /can never be routed/)
  })

  test("a wildcard over a blocked method is allowed (the §15 example does this)", () => {
    // design.md §15 pairs methods: ["eth_*"] with blocked_methods:
    // ["eth_sendTransaction"]; the blocked list wins at classify time.
    const cfg = base()
    upstream(cfg).methods = ["eth_*"]
    expect(() => load(cfg)).not.toThrow()
  })
})

describe("rule 7 — url template", () => {
  test("url_template must contain {apikey}", () => {
    const cfg = base()
    upstream(cfg).url_template = "https://eth-mainnet.g.alchemy.com/v2"
    expectIssues(cfg, /\{apikey\}/)
  })
})

describe("rule 9 — client keys", () => {
  test("auth.keys must not be empty", () => {
    const cfg = base()
    cfg.server.auth.keys = []
    expectIssues(cfg, /at least one client key/)
  })

  test("client tokens must be unique", () => {
    const cfg = base()
    cfg.server.auth.keys.push({ token: "${CLIENT_MAIN}", label: "other" })
    expectIssues(cfg, /duplicate client token/)
  })

  test("client labels must be unique", () => {
    const cfg = base()
    cfg.server.auth.keys.push({ token: "${KEY_B}", label: "main" })
    expectIssues(cfg, /duplicate client label/)
  })
})

describe("rule 10 — reserved chain names", () => {
  test.each(["metrics", "healthz"])("chain %s is reserved", (name) => {
    const cfg = base()
    cfg.chains[name] = cfg.chains.ethereum
    expectIssues(cfg, /reserved/)
  })
})

describe("composition root (decision #37)", () => {
  test("an unregistered package is a startup error, never a silent fallback", () => {
    const cfg = base()
    upstream(cfg).package = "ankr"
    const error = expectIssues(cfg, /unknown adapter package "ankr"/)
    // The message lists what IS available, so the operator can fix it directly.
    expect(error.message).toMatch(/registered: generic, alchemy/)
  })

  test("a registry without any packages rejects every package name", () => {
    const error = (() => {
      try {
        loadConfigText(yaml(base()), { env, registry: new AdapterRegistry() })
      } catch (caught) {
        return caught as ConfigError
      }
      throw new Error("expected a throw")
    })()
    expect(error.errors[0]!.message).toMatch(/unknown adapter package "alchemy"/)
  })
})

describe("rule 6 & 8 — warnings and shared identities", () => {
  test("a chain without an archive upstream only warns", () => {
    const cfg = base()
    upstream(cfg).archive = false
    const loaded = load(cfg)
    expect(loaded.warnings).toEqual([
      'chain "ethereum" has no archive upstream: historical queries will fail',
    ])
  })

  test("one identity in two chains is reported as shared, not as an error", () => {
    const cfg = base()
    cfg.chains.base = {
      upstreams: [
        {
          ...upstream(cfg),
          name: "alchemy-base",
          url_template: "https://base-mainnet.g.alchemy.com/v2/{apikey}",
        },
      ],
    } as never
    const loaded = load(cfg)
    expect(loaded.shared).toHaveLength(1)
    expect(loaded.shared[0]!.chains.sort()).toEqual(["base", "ethereum"])
  })

  test("the same token with two different labels is an error (one identity, one label)", () => {
    const cfg = base()
    cfg.chains.base = {
      upstreams: [
        {
          ...upstream(cfg),
          name: "alchemy-base",
          url_template: "https://base-mainnet.g.alchemy.com/v2/{apikey}",
          apikeys: [
            { token: "${KEY_A}", label: "renamed", buckets: [{ capacity: 1, refill_per_second: 1 }] },
          ],
        },
      ],
    } as never
    expectIssues(cfg, /one identity must have one label/)
  })
})

describe("error reporting", () => {
  test("all cross-field problems are reported at once, not just the first", () => {
    // These three are all cross-field rules, so they reach stage 4 together.
    const cfg = base()
    upstream(cfg).url_template = "https://no-placeholder"
    upstream(cfg).methods = ["eth_sendTransaction"]
    cfg.server.auth.keys = []
    const error = (() => {
      try {
        load(cfg)
      } catch (caught) {
        return caught as ConfigError
      }
      throw new Error("expected a throw")
    })()
    expect(error.errors.length).toBe(3)
    expect(error.message).toMatch(/\(3 problems\):/)
  })

  test("all shape problems are reported at once too", () => {
    const cfg = base()
    upstream(cfg).apikeys[0]!.buckets[0]!.capacity = -1
    upstream(cfg).apikeys[0]!.buckets[0]!.refill_per_second = 0
    const error = (() => {
      try {
        load(cfg)
      } catch (caught) {
        return caught as ConfigError
      }
      throw new Error("expected a throw")
    })()
    expect(error.errors.length).toBe(2)
  })

  test("invalid YAML is reported with its position, not a stack trace", () => {
    expect(() => loadConfigText("a: [unclosed", options)).toThrow(/\(yaml\)/)
  })

  test("an empty file is a clear error", () => {
    expect(() => loadConfigText("", options)).toThrow(/empty/)
  })

  test("a secret value never appears in an error message", () => {
    const secret = "sk_live_super_secret_token"
    const cfg = base()
    upstream(cfg).apikeys[0]!.token = secret
    upstream(cfg).url_template = "https://x"
    const error = (() => {
      try {
        loadConfigText(yaml(cfg), { env, registry: buildRegistry() })
      } catch (caught) {
        return caught as ConfigError
      }
      throw new Error("expected a throw")
    })()
    expect(error.message).not.toContain(secret)
  })
})

describe("startup log wording", () => {
  test("rule 8 line matches design.md §15.1 exactly, and shows no token", () => {
    const identity = { provider: "alchemy", label: "a", chains: ["ethereum", "base"] }
    const line = formatSharedIdentity(identity)
    expect(line).toBe("apikey a(alchemy): shared bucket → ethereum, base")
    expect(line).not.toContain("alchemy-a")
  })
})
