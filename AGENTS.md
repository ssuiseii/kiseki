# AGENTS.md

Working rules for agents in this repository. Read this file before changing
anything.

For research notes and design proposals, follow [`notes/AGENTS.md`](notes/AGENTS.md).
This file does not repeat those rules.

---

## Project

Kiseki is a JSON-RPC proxy for EVM chains. Clients send JSON-RPC 2.0 requests
to one endpoint; Kiseki picks the upstream for each item, picks an apikey inside
that upstream, and returns the answer in the shape the client sent.

Routing has two levels:

- **Level 1 (router, `packages/kiseki`)** picks an upstream instance.
- **Level 2 (`ApikeyPool`, `packages/upstream-core`)** picks an apikey inside
  that instance and handles failover between keys.

The router never sees apikeys. The pool never sees other instances.

**Stack:** TypeScript only, Bun ≥ 1.1, Bun workspaces. Runtime dependencies:
`hono`, `prom-client`, `yaml`, `zod`.

---

## Repository layout

```
.
├── AGENTS.md                 this file
├── ARCHITECTURE.md           architecture of the running code (source of truth)
├── README.md                 user-facing overview
├── docs/                     project documentation only
│   └── upstream-package-guide.md
├── notes/                    research notes and proposals (see notes/AGENTS.md)
├── kiseki.yaml               example configuration
├── kiseki.service            systemd unit
├── package.json              workspace root and scripts
├── tsconfig.base.json        shared compiler options
├── .github/workflows/ci.yml  CI
└── packages/
    ├── kiseki/               process, HTTP server, auth, router, batch pipeline
    ├── upstream-core/        engine: adapter contract, ApikeyPool, buckets, cost
    ├── upstream-generic/     config-driven fallback provider
    ├── upstream-alchemy/     thin provider: CU table, error signatures
    └── upstream-ankr/        thin provider: AAPI credits, kiseki_* translations
```

Each package has `src/`, `test/`, `package.json`, and `tsconfig.json`.
`packages/kiseki/dist/` is build output. Never edit it.

---

## Commands

Run from the repository root.

| Command | What it does |
|---|---|
| `bun install` | Install dependencies |
| `bun run check` | Typecheck every package, then run every test. **Must pass before work is done.** |
| `bun run typecheck` | Typecheck every package |
| `bun run test` | Run every test |
| `bun run test:core` | Test `upstream-core` only |
| `bun run test:kiseki` | Test `kiseki` only |
| `bun test packages/<package>` | Test one package |
| `bun run build` | Compile the binary to `packages/kiseki/dist/kiseki` |

CI runs `bun install --frozen-lockfile`, typecheck, the full test suite, the
build, and the boundary suites on Linux and macOS. If you add a package, add its
`tsc --noEmit -p packages/<package>/tsconfig.json` step to the `typecheck`
script in `package.json`.

---

## Architecture rules

`ARCHITECTURE.md` is the source of truth for how the system works. Its
**Invarian** section lists the properties that must stay true; breaking one is
an architecture change, not an implementation detail. The rules below are the
ones agents most often need.

### Dependency direction

```
packages/kiseki                  ──▶ upstream-core
packages/upstream-<provider>     ──▶ upstream-core
packages/kiseki/src/registry.ts  ──▶ upstream-core + every provider package
```

- `upstream-core` imports nothing from `kiseki` or from any provider package.
- A provider package imports only `upstream-core`. It never imports `kiseki` or
  another provider package.
- `packages/kiseki/src/registry.ts` is the **only** file in `kiseki` allowed to
  import provider packages. It holds no logic.
- `upstream-core` exposes its public surface only through `src/index.ts`.

### Responsibilities

| Package | Must not |
|---|---|
| `kiseki` | Select apikeys, deduct quota, or parse provider errors |
| `upstream-core` | Know about the HTTP server, configuration, or observability |
| `upstream-<provider>` | Contain routing, apikey selection, cooldown, or HTTP classification |

### Non-negotiable behavior

- **Never expose a token.** Apikeys and client keys never appear in logs,
  metrics, error messages, responses, test names, or documents. Refer to keys
  by label only.
- **Quota is deducted before the request is sent**, once per attempt, with no
  refund.
- **An ambiguous outcome on `eth_sendRawTransaction` stops both routing levels.**
  No retry path may exist for it.
- **Provider errors pass through verbatim.** A domain error is never retried or
  rewritten.
- **Capability-error matchers are conservative.** When unsure, return `null`.
  A pattern that swallows domain errors causes useless regroups and burns quota.
- **Static configuration is the source of capability.** Runtime signals only
  correct it.

If a change seems to require breaking one of these rules or touching the
router, pre-flight, grouping, or server for a provider-specific need, stop. That
is a design change and needs a proposal first (see `notes/AGENTS.md`).

---

## Adding or changing a provider

1. If the provider is an upstream or external service, write a research note
   first (see `notes/AGENTS.md`).
2. Check whether `package: generic` is enough. A package is needed only for
   its own cost units, error signatures, mandatory headers, or `kiseki_*`
   translations.
3. Follow `docs/upstream-package-guide.md`, including its PR checklist.
4. Register the package in `packages/kiseki/src/registry.ts` (one import, one
   `register` line). Nothing else outside the package should change; if more
   does, explain why.

---

## Code style

No formatter or linter is configured. Match the existing code:

- No semicolons, double quotes, two-space indentation.
- Code comments and identifiers in English.
- Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Compiler options in `tsconfig.base.json` are strict, including
  `noUncheckedIndexedAccess` and `noUnusedLocals`. Do not loosen them.
- Every package's `tsconfig.json` extends `../../tsconfig.base.json`.

---

## Tests

- Tests use `bun:test` and live in `packages/<package>/test/`.
- **Tests never use the network or secrets.** Fetch, clock, and randomness are
  injected. Boundary suites (`e2e`, `binary`, Ankr suites) spawn their own mock
  upstream on `127.0.0.1`.
- Follow the injection harness in `packages/upstream-alchemy/test/alchemy.test.ts`
  for provider packages: a `BucketRegistry`, a fake `fetchImpl`, and a static
  `now()`. No timer mocks.
- Router tests use the fake adapters in `packages/kiseki/test/helpers.ts`.
- **Provider fixtures and error strings come from real responses**, copied
  verbatim from a research note. Never invent the provider's message: a test
  that asserts against its own invented string proves nothing.

---

## Secrets and configuration

- `.env` and `.env.*` are git-ignored and hold live provider keys. Never commit,
  print, or copy their values.
- Configuration reads secrets as `${VAR}` from the environment. Examples in
  `kiseki.yaml` and documents always use `${VAR}`, never a raw token.
- `kiseki.service` reads its environment from `/etc/kiseki/env`.
- `dev.yaml` and `config.yaml` are git-ignored local configurations. Never
  commit them; `kiseki.yaml` is the only committed example.

---

## Documentation

| Document | Language | Purpose |
|---|---|---|
| `ARCHITECTURE.md` | Indonesian | Architecture of the running code |
| `docs/` | — | Project documentation only. No research notes or proposals. |
| `notes/` | Indonesian | Research notes and proposals (rules in `notes/AGENTS.md`) |
| `README.md` | English | Overview, install, usage |
| `AGENTS.md` files | English | Agent rules |

When an implemented change alters behavior described in `ARCHITECTURE.md`,
`README.md`, or `docs/upstream-package-guide.md`, update those documents in the
same change.

### Stale references

`docs/design.md`, `docs/implementation.md`, and `plan/` no longer exist. Many
code comments, test names, configuration comments, and older documents still
refer to them (for example `design.md §5.3`, `plan/notes-m0.md`, or decision
numbers such as `#37`).

- Treat these references as stale. Do not try to find or recreate the removed
  files, and do not rely on their section or decision numbers.
- For how the system works, read `ARCHITECTURE.md`. For provider facts, read
  `notes/research-notes/`.
- **New references must point to `ARCHITECTURE.md` (by section title) or to a
  document that exists.** Never add a new reference to a removed document.
- Do not mass-edit existing stale references as a side task. Fix one only when
  you are already changing that line for another reason.

---

## Permissions

| Action | Allowed without approval? |
|---|---|
| Change `kiseki.yaml`, `kiseki.service`, or `.github/workflows/ci.yml` | Yes, when the task requires it |
| Add dependencies | Yes |
| Use the live keys in `.env` for measurements | Yes |
| Commit | Yes, only when **every** test passes |
| Push | **No.** Wait for the maintainer's approval |

### Configuration and CI

Change these files only when the task actually needs it (for example, an
example instance for a new provider, or a typecheck step for a new package).
Do not change them as cleanup or as a side task.

### Dependencies

When you add a dependency, add it to the package that uses it, commit the
updated `bun.lock`, and confirm `bun install --frozen-lockfile` still works.

### Live measurements

Measurements for a research note **must** use the live keys in `.env`.
Documentation alone is not a measurement (see `notes/AGENTS.md`).

- Load keys without printing them. A key never appears in terminal output,
  logs, documents, commit messages, or test files.
- Live calls belong to research only. Tests never use the network or live keys.
- Live calls cost real quota. Keep the number of requests to what the
  measurement needs.

### Commits

Commit only when `bun run check` passes with **zero failing tests**. A commit
with a failing, skipped-to-pass, or deleted test is not allowed.

Never push. When work is ready, report it and wait for the maintainer to
approve the push.

---

## Commit messages

A commit message starts with a **tag** that names the kind of change, followed
by a colon and a short summary:

```
<tag>: <summary>
```

Examples of tags: `Fix:`, `Add:`, `chore:`, and similar.

- **Never use a plan or milestone name as the prefix.** Milestone IDs and plan
  names (`M1`, `M-C`, `Rencana B`, …) mean nothing outside the session that
  created them.

  ```
  M1: fix error handler ...      ✗ wrong
  Fix: error handler ...     ✓ right
  ```

- Never put a token or key in a commit message.

---

## Branches

- **Never push directly to `main`.** Every change reaches `main` through a pull
  request.
- Work on a separate branch, not on `main`.
- Pushing that branch still requires the maintainer's approval (see
  [Commits](#commits)).
