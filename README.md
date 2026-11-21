# Kiseki

A blockchain RPC proxy that actually thinks about where your requests go.

Kiseki sits between your apps (forge, cast, ethers, indexers — anything that
speaks JSON-RPC) and a pile of upstream providers like Alchemy, Ankr, or dRPC.
Instead of pointing every tool at one provider URL and hoping the rate limit
holds, you point everything at Kiseki and let it figure out the rest.

## What it does

**Two-level routing.** Level 1 picks the right *provider* for the job; level 2
(the provider package) picks the right *apikey* from that provider's pool. When
key A gets throttled, key B takes over inside the pool — and only when every
key is drained does the router even notice and try another provider. Your app
sees none of this.

**Quota that matches reality.** Providers count limits differently — RPS, RPM,
CU/s. Kiseki models all of it as token buckets with lazy refill, deducted per
batch item *before* the request goes out, with no refunds. Conservative by
design: better to shed load early than to burn a provider's trust.

**Capability routing.** Not every upstream supports `trace_*`, `debug_*`, or
archive state. Kiseki checks statically from config before sending, and if a
provider turns out to lie about its capabilities at runtime, the affected items
are re-routed to an upstream that can actually serve them — same request, same
response, transparent to the client.

**Fail fast.** No queues. When everything is exhausted you get a clean `429`
with a realistic `Retry-After` estimate, so client-side backoff doesn't have to
be guesswork.

**Send-safe by default.** `eth_sendRawTransaction` gets special treatment: an
ambiguous result (timeout, 5xx after broadcast) stops *all* failover dead, so
you never end up with "success from upstream two" for a transaction that may
already be in the mempool.

**One namespace for provider-specific APIs.** Providers expose their own
non-standard methods (`ankr_getTokenTransfers`, `alchemy_getAssetTransfers`, …)
that differ in name, params and shape. Kiseki serves a neutral `kiseki_*`
namespace on top: call `kiseki_getTokenTransfers` and the provider package
translates both directions into one stable, provider-independent shape. The raw
provider method still works if you want it.

**Keys stay keys.** Client auth is path-key (`http://host:8545/ethereum/YOUR_KEY`)
or Bearer — whichever your tooling prefers, validated against the same
allowlist. Upstream apikey tokens and client keys are never logged, only labels.

## How it works (30-second version)

```
Client ──▶ kiseki (classify · pre-flight · batch split/regroup)
              │ picks a provider, weighted by free capacity
              ▼
        upstream package  ──▶  ApikeyPool (picks an apikey, deducts quota)
              │                     │ failover across keys here
              ▼                     ▼
        provider RPCs (Alchemy, Ankr, dRPC, …)
```

Batch requests are split by capability needs, sent in parallel, and merged back
in the original order — partial success is fine.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 — that's it. No other runtime needed to build or
  run; the compiled binary is self-contained.

## Build & install

Clone the repo, then:

```bash
bun install        # fetch deps + register workspaces
bun run check      # typecheck + full test suite
bun run build      # compile a single binary → packages/kiseki/dist/kiseki
```

Drop the binary wherever you like, for example:

```bash
sudo cp packages/kiseki/dist/kiseki /usr/local/bin/kiseki
```

### Run it

```bash
kiseki --config /etc/kiseki/kiseki.yaml
```

| Flag | Meaning |
|---|---|
| `--config, -c <path>` | config file (default: `$KISEKI_CONFIG` or `./kiseki.yaml`) |
| `--check` | validate the config and exit — handy before a systemd restart |
| `--help, -h` | usage |

You can also develop without compiling: `bun run dev` from
`packages/kiseki`, or `bun run --filter kiseki dev`.

### Config

Everything lives in one YAML file — `kiseki.yaml` in the working directory by
default. Secrets come from the environment via `${VAR}` interpolation; a
missing variable is a startup error, not a silent empty key. Start from
[`kiseki.yaml`](kiseki.yaml) at the repo root — it's a complete, commented
example covering multi-key pools, shared buckets across chains, and per-provider
cost overrides.

A minimal taste:

```yaml
server:
  port: 8545
  host: "127.0.0.1"
  auth:
    keys:
      - { token: "${KISEKI_KEY_MAIN}", label: main }

chains:
  ethereum:
    upstreams:
      - name: alchemy-ethereum
        provider: alchemy
        package: alchemy
        url_template: "https://eth-mainnet.g.alchemy.com/v2/{apikey}"
        apikeys:
          - { token: "${ALCHEMY_KEY_A}", label: a,
              buckets: [{ capacity: 330, refill_per_second: 330 }] }
        methods: ["eth_*", "trace_*", "debug_*"]
        archive: true
```

That's a working Alchemy upstream: one client key, one provider apikey, 330
CU/s bucket. Add more apikeys to the pool and failover between them is
automatic. Reload config live with `SIGHUP` — running buckets are preserved.

## Development

```bash
bun test                  # everything
bun run test:core         # just upstream-core
bun run typecheck         # tsc across all packages
```

Tests are colocated per package and run without network access (fetch, clock
and randomness are injected), so they're fast and deterministic.

### Adding a provider

Most providers need nothing at all — point `package: generic` at their URL
template in config and you're done. If your provider has its own cost units,
quirky error messages, or mandatory headers, it gets a thin package of its own.
The whole process is one short file plus a two-line registration — see
[docs/upstream-package-guide.md](docs/upstream-package-guide.md) for the
step-by-step tutorial and the full hook reference.

### The `kiseki_*` namespace

Six methods are currently canonical, all served by the Ankr package:

| Canonical | Ankr upstream |
|---|---|
| `kiseki_getTokenTransfers` | `ankr_getTokenTransfers` |
| `kiseki_getTransactionsByAddress` | `ankr_getTransactionsByAddress` |
| `kiseki_getAccountBalance` | `ankr_getAccountBalance` |
| `kiseki_getNFTsByOwner` | `ankr_getNFTsByOwner` |
| `kiseki_getNFTMetadata` | `ankr_getNFTMetadata` |
| `kiseki_getTokenPrice` | `ankr_getTokenPrice` |

Coverage is derived, never configured: a `kiseki_*` method is advertised only
when the upstream method behind it matches the instance's `methods:` list. If
you narrow `methods:`, the canonical method disappears with it.

**Two Ankr gotchas worth knowing before you copy the example config:**

- Ankr serves its Advanced API (`ankr_*`) **only** on
  `https://rpc.ankr.com/multichain/{key}`, and that endpoint rejects every node
  method. The per-chain endpoint is the mirror image. One instance has one
  `url_template`, so Ankr needs **two instances per chain** — see
  `kiseki.yaml`. Give them different `provider:` values: that field is the
  bucket-sharing identity, and mixing credit-metered and RPS-metered buckets
  under one identity silently rebuilds the bucket.
- An Advanced API call costs **700 API credits**, not 1. A bucket sized for RPS
  is drained ~47× faster than by `eth_call`, so size the AAPI bucket in credits
  or it will look permanently exhausted.

## Project layout

```
packages/
├── kiseki/            # main: HTTP server, auth, router, batch pipeline
├── upstream-core/     # the engine: adapter contract, ApikeyPool, buckets
├── upstream-generic/  # config-driven fallback provider
├── upstream-alchemy/  # thin provider: CU table + error signatures
└── upstream-ankr/     # thin provider: 700-credit AAPI + kiseki_* translations
```

## Docs

- [docs/design.md](docs/design.md) — the full architecture design: goals,
  frozen decisions, routing, quota model, error policy, config schema, and the
  reasoning behind every tradeoff.
- [docs/implementation.md](docs/implementation.md) — the concrete code plan:
  contracts, algorithms, milestones, and the test plan.
- [docs/upstream-package-guide.md](docs/upstream-package-guide.md) — how to
  write a new upstream package and wire it into Kiseki.

## Status

v1.3 design, implemented and tested. Self-use oriented: single process,
in-memory state, no multi-tenancy, no WebSocket yet — the roadmap for those
lives at the end of the design doc.

## License

Private project. All rights reserved unless a license file says otherwise.
