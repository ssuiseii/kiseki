/**
 * `${VAR}` interpolation for the config (design.md §15.1 rule 4).
 *
 * A missing variable is a startup error, not an empty string: a silently empty
 * apikey would turn every upstream request into an anonymous one and only fail
 * later, at the provider, as a 401 we would misread as a sick key.
 *
 * Two optional forms, both needed by a real deployment:
 *
 *   `${VAR:-fallback}`     use `fallback` when VAR is unset or empty
 *   `${VAR?why it matters}` error with that hint when VAR is unset or empty
 *
 * The `?` form exists so a config can say why the variable matters instead of
 * leaking the generic message. Only the *name* is ever reported — never a value,
 * because interpolated values are secrets (design.md §18.2).
 *
 * Interpolation runs on YAML **values**, after parsing, not on the raw text.
 * Substituting into the raw text would also rewrite comments — and a config that
 * documents its own `${VAR}` syntax (as `kiseki.yaml` does) would then fail to
 * start. Values are substituted verbatim, so a token containing `:` or `#` must
 * be quoted in the YAML; `$${...}` escapes to a literal `${...}`.
 */

export type InterpolateResult =
  | { ok: true; text: string }
  | { ok: false; errors: string[] }

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-|\?)([^}]*))?\}/g

/** `process.env`-shaped source; a plain object is enough for tests. */
export type EnvSource = Record<string, string | undefined>

const substitute = (
  text: string,
  env: EnvSource,
  errors: string[],
): string =>
  // `$${VAR}` escapes to a literal `${VAR}`: the placeholder survives as text.
  text
    .replace(/\$\$\{/g, "\u0000{")
    .replace(
      VAR_PATTERN,
      (_match, rawName: string, operator: string | undefined, argument: string | undefined) => {
        const name = rawName
        const value = env[name]
        const present = value !== undefined && value !== ""

        if (operator === undefined) {
          if (!present) {
            errors.push(`missing environment variable ${name} (referenced as \${${name}})`)
            return ""
          }
          return value
        }

        if (operator === ":-") return present ? value : (argument ?? "")

        // operator === "?"
        if (!present) {
          const hint = argument === undefined || argument === "" ? "" : `: ${argument}`
          errors.push(`missing environment variable ${name}${hint}`)
          return ""
        }
        return value
      },
    )
    .replace(/\u0000\{/g, "${")

/** Interpolate one string. */
export const interpolate = (text: string, env: EnvSource): InterpolateResult => {
  const errors: string[] = []
  const result = substitute(text, env, errors)
  return errors.length === 0 ? { ok: true, text: result } : { ok: false, errors }
}

/**
 * Interpolate every string value in a parsed YAML tree, leaving keys and comments
 * alone (comments are already gone after parsing).
 *
 * Paths are reported so the operator knows which field needs the variable, e.g.
 * `chains.ethereum.upstreams[0].apikeys[0].token`.
 */
export const interpolateTree = (
  value: unknown,
  env: EnvSource,
): { ok: true; value: unknown } | { ok: false; errors: { path: string; message: string }[] } => {
  const errors: { path: string; message: string }[] = []

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === "string") {
      const local: string[] = []
      const substituted = substitute(node, env, local)
      for (const message of local) errors.push({ path, message })
      return substituted
    }
    if (Array.isArray(node)) {
      return node.map((entry, index) => walk(entry, `${path}[${index}]`))
    }
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(node)) {
        out[key] = walk(entry, path === "" ? key : `${path}.${key}`)
      }
      return out
    }
    return node
  }

  const walked = walk(value, "")
  return errors.length === 0 ? { ok: true, value: walked } : { ok: false, errors }
}

/**
 * Which variables a text references. Used by tests and diagnostics; never
 * exposes values.
 */
export const referencedVariables = (text: string): string[] => {
  const names = new Set<string>()
  for (const match of text.matchAll(VAR_PATTERN)) names.add(match[1]!)
  return [...names]
}
