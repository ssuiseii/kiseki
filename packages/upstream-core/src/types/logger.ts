/**
 * Structured logging contract. Injected everywhere (implementation.md §1) so
 * tests can assert on log content and so the concrete sink stays in `kiseki`.
 *
 * HARD RULE (design.md §18.2): never log upstream apikey tokens or client keys.
 * Callers pass `label` only; core never sees a reason to log a token.
 */

export type LogFields = Record<string, unknown>

export type Logger = {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

/** Discards everything. Default for unit tests that do not assert on logs. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
