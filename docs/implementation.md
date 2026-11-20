# Rencana Implementasi — Kiseki (panduan kode konkret)

> Status: **v1.3** — mengikuti `docs/design.md` v1.3. Referensi keputusan memakai
> nomor # di §2 design.md. Dokumen ini berisi kontrak kode, algoritme konkret,
> urutan milestone, dan test plan — design.md tetap dokumen konseptual.
> Sesuai protokol: struktur & kontrak di bawah sudah disepakati lewat diskusi
> (keputusan #34–40); coding dimulai dari Milestone 1 setelah persetujuan.

---

## Daftar Isi

1. [Stack & Dependency](#1-stack--dependency)
2. [Kontrak Kode upstream-core](#2-kontrak-kode-upstream-core)
3. [Algoritme ApikeyPool (level 2)](#3-algoritme-apikeypool-level-2)
4. [Algoritme Router (level 1) + Regroup Loop](#4-algoritme-router-level-1--regroup-loop)
5. [Signature Capability-Mismatch (capsig)](#5-signature-capability-mismatch-capsig)
6. [Pipeline Config (zod)](#6-pipeline-config-zod)
7. [Server & Auth](#7-server--auth)
8. [Milestone](#8-milestone)
9. [Test Plan](#9-test-plan)

---

## 1. Stack & Dependency

| Bagian | Pilihan | Catatan |
|---|---|---|
| Runtime | Bun ≥ 1.1 | `bun build --compile` untuk binary tunggal |
| Workspaces | Bun workspaces (`packages/*`) | keputusan #28 |
| HTTP server | `hono` | Hono untuk Bun, route dinamis `/{chain}/{key}` |
| Validasi config | `zod` | keputusan #38; cross-field ditulis manual di atasnya |
| YAML | `yaml` | parsing + interpolasi `${VAR}` manual |
| Metrics | `prom-client` | registry default, endpoint `/metrics` |
| Dependency runtime lain | — | tidak ada; bucket/pool/registry pure TS |

Injection style: **constructor injection** untuk `now()`, `logger`, `fetchImpl` —
memudahkan test deterministik tanpa mock timer.

---

## 2. Kontrak Kode upstream-core

Semua tipe di bawah final (mengikuti design.md §7.1 versi v1.3). File:

```
packages/upstream-core/src/
├── types/
│   ├── jsonrpc.ts      # JsonRpcId, JsonRpcRequest, JsonRpcError, JsonRpcResult
│   ├── outcome.ts      # Entry, UnsupportedItem, UpstreamOutcome
│   └── group.ts        # Group, GroupItem, AttemptCtx
├── adapter.ts          # UpstreamAdapter, AdapterFactory, CoreDeps
├── registry.ts         # AdapterRegistry
├── bucket.ts           # Bucket + BucketRegistry (identity-keyed)
├── pool.ts             # ApikeyPool
├── http.ts             # postJson (fetch + AbortSignal.timeout)
├── result.ts           # klasifikasi HTTP response → per-item entries
├── capsig.ts           # deteksi capability-mismatch (lihat §5)
└── index.ts            # public exports
```

```ts
// types/jsonrpc.ts
type JsonRpcId = string | number | null
type JsonRpcError = { code: number; message: string; data?: unknown }

// types/group.ts
type GroupItem = {
  originalIndex: number
  id: JsonRpcId
  method: string
  params: unknown[]
}

type Group = {
  chain: string
  items: GroupItem[]
  needsArchive: boolean
  idempotency: "READ" | "NON_IDEMPOTENT"
  timeoutMs: number
  countsBatchAsOne: boolean   // dari config instance upstream
}

type AttemptCtx = {
  attempt: number             // 0-based, per (upstream, grup)
  logger: Logger
  now(): number
}

// types/outcome.ts — taxonomy final (design.md §7.1, keputusan #34–36)
type Entry =
  | { originalIndex: number; ok: true;  result: unknown }
  | { originalIndex: number; ok: false; error: JsonRpcError; final: boolean }

type UnsupportedItem = {
  originalIndex: number
  method: string
  cap: "method" | "archive"
  providerError: JsonRpcError
}

type UpstreamOutcome =
  | { kind: "success"; entries: Entry[]; unsupportedItems?: UnsupportedItem[] }
  | { kind: "domain_error"; entries: Entry[] }
  | { kind: "unsupported"; items: UnsupportedItem[] }
  | { kind: "rate_limited"; retryAtMs: number }
  | { kind: "sick"; retryAtMs: number }
  | { kind: "ambiguous" }
```

```ts
// adapter.ts
type CoreDeps = {
  bucketRegistry: BucketRegistry
  logger: Logger
  now(): number
  fetchImpl?: typeof fetch      // override untuk test
}

interface UpstreamAdapter {
  readonly name: string                     // nama instance config
  readonly provider: string
  capability(): { methods: string[]; archive: boolean }
  weight(): number                          // Σ headroom apikey (design.md §6.2)
  earliestReadyAt(): number                 // ms epoch, untuk Retry-After
  attempt(group: Group, ctx: AttemptCtx): Promise<UpstreamOutcome>
}

// provider package mengekspor INI (dipanggil composition root):
type AdapterFactory = (cfg: UpstreamInstanceConfig, deps: CoreDeps) => UpstreamAdapter
```

```ts
// registry.ts — didata composition root; logika router hanya baca
class AdapterRegistry {
  register(packageName: string, factory: AdapterFactory): void
  factory(packageName: string): AdapterFactory | undefined
}
```

**Aturan penting kontrak:**

- `cost` TIDAK ada di `GroupItem` — pool yang menghitung cost saat memilih
  apikey (override per provider, design.md §5.3). `Group.cost()` helper di
  pool menerima cost resolver dari provider package.
- `entries` pada `success`/`domain_error` SELALU lengkap untuk semua item grup
  yang dikirim; router hanya perlu merge, tidak pernah menciptakan hasil.
- `final: false` pada entry error hanya dipakai internal pool untuk item
  mismatch yang menunggu regroup; setelah finalisasi router, semua entry yang
  diteruskan berstatus final.

---

## 3. Algoritme ApikeyPool (level 2)

`pool.ts` — generik, dipakai semua provider package:

```
attempt(group, ctx):
  tried = ∅
  mismatchAccum  = []   # UnsupportedItem[]
  entriesAccum   = []   # Entry[] sukses + domain error
  lastProviderErr = null

  loop:
    ready = [ k ∈ keys | k ∉ tried
                       ∧ ∀ bucket b: credits(b, ctx.now) ≥ cost(group)
                       ∧ cooldownUntil(b) ≤ ctx.now ]
    if ready = ∅:
      if entriesAccum ∪ mismatchAccum tidak kosong:
        return poolOutcome(entriesAccum, mismatchAccum, group)
      return { kind: rate_limited, retryAtMs: earliestReadyAt() }

    key = weightedRandom(ready, weight_k = min over buckets(credits/capacity))
    deductAllBuckets(key, cost(group))          # sync, SEBELUM fetch (§5.5)

    res = postJson(url(key, group), body(group), timeoutMs(group))
    classify res via provider parser + capsig:

      sukses per item / domain error per item
        → masuk entriesAccum
      item mismatch (-32601 / state pruned / block-not-found historis)
        → mismatchAccum += {originalIndex, method, cap, providerError}
        → note instance: capabilityNote(instance, cap, method)
      HTTP 429                    → bucket=0 semua bucket key + cooldown → tried += key; continue
      5xx / timeout / conn fail   → READ: cooldown eksponensial key → tried += key; continue
                                    sendRaw: return { kind: ambiguous }  # STOP (§11.3)
      sendRaw definitif ditolak   → entry final domain_error → return domain_error
      provider-level sick (≥3 gagal lintas key) → return { kind: sick, retryAtMs }
```

`poolOutcome(...)`:
- semua item mismatch → `{ kind: "unsupported", items: mismatchAccum }`
- sebagian mismatch → `{ kind: "success", entries: entriesAccum, unsupportedItems: mismatchAccum }`
- tidak ada mismatch → `success` / `domain_error` sesuai isi.

**Bucket (bucket.ts):**

```
credits(b, now) = min(b.capacity, b.credits + (now - b.lastRefill) * b.refill_per_second)
deduct(b, c)    = b.credits = credits(b, now) - c   # lazy refill inline
```

`BucketRegistry.get(provider, token, bucketsSpec)` — key = `provider + "\u0000"
token`; object bucket dibuat sekali dan **dishare** antar instance chain
(keputusan #24). Membuat config ulang (SIGHUP) memanggil
`registry.retain(identitySet)` untuk membuang bucket identity yang tak lagi
dirujuk (design.md §19).

---

## 4. Algoritme Router (level 1) + Regroup Loop

Di `kiseki` package, `batch/` + `router/`:

```
handle(items[]):
  # tahap A — klasifikasi + pre-flight (§9, §8.2)
  per item: classify → needsArchive, idempotency, timeout class
  preflightSet(item) = { u ∈ upstreams(chain) | capability ok ∧ ¬runtimeNote(u, need) }
  set kosong → final item: -32601 instan (tanpa potongan kuota)

  # tahap B — grup awal
  groups = groupBy(item, key = (frozenset(preflightSet), needsArchive, idempotency))
  pending = { groupId → items }

  # tahap C — attempt loop level 1 + regroup loop (#34)
  while pending ≠ ∅:
    jalankan SEMUA grup paralel; tiap grup:
      tried = ∅
      loop:
        eligible = preflightSet(grup) − tried − { u | weight(u)=0 ∨ sick(u) }
        kosong → grup berakhir: items.finalize(per §12 fail-fast atau #36)
        u = weightedRandom(eligible, weight(u) = Σ headroom apikey)
        outcome = u.attempt(grup, ctx)
        tried += u
        match outcome:
          success(entries, unsupportedItems?) →
            entriesAccum += entries
            unsupportedItems ada → item kembali ke pending (regroup);
              preflightSet(item) kini exclude u (runtime note)
          unsupported(items) → regroup semua; sama seperti di atas
          rate_limited/sick → catat retryAt(u); continue loop
          domain_error → entriesAccum += entries; grup selesai
          ambiguous → item sendRaw: STOP TOTAL → -32007; grup selesai
    pending = regrouped items (grup baru bila set eligible beda)

  # tahap D — merge per originalIndex (invariant #4) → shaping response (§12.3)
```

**Finalisasi item (#36):** item yang tak punya kandidat lagi menerima
`error = providerError terakhir` yang mengakhirinya (dari `UnsupportedItem` /
outcome `rate_limited`/`sick` yang terakhir relevan). Fail-fast kapasitas
(§12) tetap bentuk 429 + `-32005` + `Retry-After`.

**Terminasi:** tiap item hanya bisa berpindah upstream ≤ jumlah upstream
eligible-nya (invariant #8) — regroup loop dijamin berhenti.

---

## 5. Signature Capability-Mismatch (capsig)

`capsig.ts` di upstream-core — tabel pattern umum + hook parser provider:

| Sinyal | cap | Pattern (fallback umum) |
|---|---|---|
| `-32601` | method | `code === -32601` |
| state hilang/pruned | archive | `missing trie node`, `state pruned`, `state not available`, `no state available`, `state for block .* (not available\|pruned)` |
| block not found **historis** | archive | `block not found`, `header not found`, `block .* not found` — hanya bila item terdeteksi historis (bukan `"latest"`/`"pending"`) |

- Provider package boleh menyediakan `matchCapabilityError(err, isHistorical):
  "method" | "archive" | null` untuk menimpa/memperketat fallback.
- isHistorical ditentukan classifier saat classify (§9.1), dibawa di
  `GroupItem` internal (field `historical: boolean`), tidak mengubah kontrak
  publik taxonomy.
- Setiap match → `kiseki_capability_regroups_total{cap=…}` increment + log
  warn `capability mismatch` (instance, method, cap) — TIDAK pernah log params.

---

## 6. Pipeline Config (zod)

Urutan parse (semua fail-fast startup, design.md §15.1):

```
raw yaml ──▶ interpolasi ${VAR} (missing → error #4)
        ──▶ zod schema (shape: server/defaults/chains/limits/metrics)
        ──▶ validasi cross-field manual:
              reserved chain names (#10 §15.1), name instance unik,
              label apikey unik per instance, blocked∩methods = ∅,
              url_template memuat {apikey}, capacity/refill > 0,
              auth.keys non-empty & unik
        ──▶ build model:
              - identity map (provider,token) → shared Bucket
              - instance config → AdapterFactory (via registry) → UpstreamAdapter
              - cost resolver: override_provider ?? default_global ?? 1
```

Zod schema mencerminkan contoh config design.md §15 satu-satu; `package:`
nilai valid = key yang teregistrasi di composition root + `"generic"` —
nilai tak dikenal → error startup (bukan silent fallback).

**Composition root (`kiseki/src/registry.ts`, keputusan #37):**

```ts
import { AdapterRegistry } from "upstream-core"
import * as alchemy from "upstream-alchemy"
import * as generic from "upstream-generic"

export function buildRegistry(): AdapterRegistry {
  const r = new AdapterRegistry()
  r.register("alchemy", alchemy.createAdapter)
  r.register("generic", generic.createAdapter)
  return r
}
```

Satu-satunya file di `kiseki` yang boleh meng-import provider package;
dilindungi dengan ESLint rule `no-restricted-imports` (opsional, M4).

---

## 7. Server & Auth

Hono app, route sesuai design.md §16–17:

```
GET  /healthz            → 200 (tanpa auth)
GET  /metrics            → prom-client (tanpa auth, keputusan #33)
POST /:chain/:key?       → authMiddleware → chainResolve → handler JSON-RPC
```

Auth middleware (urutan wajib, §16.3):

```
1. key = path param :key (jika ada & tidak kosong) ?? Bearer header
2. tidak ada / tak dikenal → 401 {"code":-32000}        # SEBELUM cek chain
3. chain tidak dikenal    → 404 {"code":-32602}
4. client_label = label kunci → dibawa ke classifier & metrics
```

Handler: parse body (array/object/invalid → `-32600`) → `handle(items)` dari
§4 → shaping respons: HTTP 200 kecuali semua-item gagal kapasitas
(429 + `Retry-After` clamp 0.5–30s).

SIGHUP → reload pipeline §6; bucket registry di-retain (identity-keyed);
adapter instance yang konfigurasinya berubah dibuat ulang; runtime note
capability direset (design.md §19).

---

## 8. Milestone

Urutan terkunci (keputusan): **upstream-core dulu**. Tiap milestone punya
Definition of Done; commit per milestone.

| # | Isi | DoD |
|---|---|---|
| **M1** | `upstream-core`: types, bucket, capsig, result, pool, http, registry + test unit | `bun test packages/upstream-core` hijau: refill lazy, identity sharing, deduct per item, weighted-random pool, 429→failover key, capsig matrix, terminasi |
| **M2** | `upstream-generic` + `upstream-alchemy` (tipis) + `kiseki/config` (zod + pipeline) | config contoh design.md §15 lolos validasi & membangun adapter instances; error config ter-handle jelas |
| **M3** | `kiseki`: classify, capability pre-flight, batch split + **regroup loop**, router weighted-random | test router: Σ headroom, regroup item mismatch ke upstream kedua, finalisasi #36, sendRaw 3-kelas |
| **M4** | `kiseki/server`: Hono + auth path-key/Bearer + shaping + metrics + logger + SIGHUP | test auth ordering (401 vs 404), shaping 429/200 parsial, `/metrics` label benar |
| **M5** | E2E `Bun test` dengan mock upstream + `bun build --compile` + `kiseki.service` | satu binary jalan dengan config nyata; e2e batch campuran sukses |

Estimasi relatif: M1 adalah fondasi terberat; M2–M4 tipis karena kontrak
sudah final di dokumen ini.

---

## 9. Test Plan

Test **colocated** per package (amandemen struktur §20 design.md):

```
packages/upstream-core/test/   bucket, pool, capsig, result
packages/kiseki/test/          classify, router(+regroup), batch, auth, shaping
```

Skenario kunci (nama test = perilaku yang dijanjikan desain):

1. `bucket lazy refill` — credits = min(cap, credits + elapsed×refill); deduct
   lintas bucket bersamaan; identity (provider,token) di 2 chain = objek sama.
2. `pool weighted-random proporsional sisa kredit` — distribusi ≈ bobot
   (statistik, toleransi), `tried` menjamin terminasi.
3. `429 → bucket 0 → key berikutnya` — refund tidak pernah terjadi.
4. `regroup: -32601 di upstream A → item lanjut ke B` — kuota A hangus, klien
   menerima jawaban B; request berikutnya tidak eligible ke A (runtime note).
5. `regroup: state pruned → upstream archive` — cap "archive".
6. `block not found historis di-retry; nonexistent → error asli passthrough`
   — signature agresif #35 + finalisasi #36.
7. `sendRaw: definitive / pre-broadcast / ambiguous` — ambiguous menghentikan
   pool DAN router (tidak ada attempt kedua upstream).
8. `auth: path-key primer, bearer fallback, 401 sebelum 404, reserved names`.
9. `shaping: batch parsial 200, semua-capacity 429 + Retry-After estimasi`.
10. `e2e: batch campuran sukses/domain/mismatch regroup` — server nyata +
    mock upstream fetchImpl.

Konsistensi log: TIDAK ADA test/pernyataan yang menuntut token/key mentah
muncul di log (logger di-inject; fake logger memverifikasi).

---

## Lampiran: Pemetaan keputusan → lokasi kode

| Keputusan | Lokasi |
|---|---|
| #24 shared bucket | `upstream-core/bucket.ts` (BucketRegistry keying) |
| #26 weighted-random apikey | `upstream-core/pool.ts` |
| #25 Σ headroom weight | `upstream-core/pool.ts` → `adapter.weight()` |
| #34 regroup re-attempt | `kiseki/batch/` + `kiseki/router/` |
| #35 signature agresif | `upstream-core/capsig.ts` + classifier `historical` |
| #36 final passthrough | `kiseki/router/` finalisasi |
| #37 composition root | `kiseki/src/registry.ts` |
| #38 zod | `kiseki/config/` |
| #39 nama `kiseki` | root `package.json` workspaces |
| #40 dokumen ini | `docs/implementation.md` |
