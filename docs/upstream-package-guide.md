# Panduan Contributor: Membuat Upstream Package Baru

> Untuk v1.3. Acuan desain: `docs/design.md` (konseptual, keputusan #1–40) dan
> `docs/implementation.md` (kontrak kode). Dokumen ini adalah tutorial praktis
> untuk contributor yang ingin menambahkan dukungan provider RPC baru ke Kiseki.
>
> Contoh yang dipakai: **`upstream-ankr` (fiktif, untuk keperluan tutorial)**.
> Referensi nyata di repo: `upstream-generic` (nol kustomisasi) dan
> `upstream-alchemy` (cost table + error signature).

---

## Daftar Isi

1. [Cara Provider Muat ke Arsitektur](#1-cara-provider-muat-ke-arsitektur)
2. [Butuh Package Sendiri, atau Cukup `generic`?](#2-butuh-package-sendiri-atau-cukup-generic)
3. [Anatomi Package](#3-anatomi-package)
4. [Tutorial: Membuat `upstream-ankr` dari Nol](#4-tutorial-membuat-upstream-ankr-dari-nol)
5. [Referensi Lengkap: `AdapterHooks`](#5-referensi-lengkap-adapterhooks)
6. [Lapisan Cost](#6-lapisan-cost)
7. [Signature Capability-Mismatch](#7-signature-capability-mismatch)
8. [Testing](#8-testing)
9. [Menghubungkan ke Kiseki (Composition Root + Config)](#9-menghubungkan-ke-kiseki-composition-root--config)
10. [Checklist PR](#10-checklist-pr)
11. [Aturan yang Tidak Boleh Dilanggar](#11-aturan-yang-tidak-boleh-dilanggar)

---

## 1. Cara Provider Muat ke Arsitektur

Kiseki melakukan routing **dua level** (design.md §3, keputusan #21):

```
Client → kiseki (router level 1) → upstream package (provider) → ApikeyPool → provider RPC
```

Sebuah **upstream package** adalah lapisan tipis milik satu provider. Ia tidak
berisi logika routing — semua logika pool (weighted-random apikey, deduct kuota,
cooldown, klasifikasi hasil) sudah ada di `upstream-core`. Yang tersisa untuk
package provider hanyalah **keunikan provider itu**:

| Keunikan | Contoh |
|---|---|
| Tabel cost default | CU asli Alchemy (`ALCHEMY_CU`) |
| Signature error khas | pesan "not available on free plan" Alchemy |
| Header wajib | beberapa provider menuntut header khusus |
| Bill per HTTP call | provider yang menghitung batch sebagai 1 request |

Kontrak yang dilihat router (ia **tidak pernah** tahu detail internalmu):
`capability()`, `weight()`, `earliestReadyAt()`, `attempt()` → `UpstreamOutcome`
(`upstream-core/src/adapter.ts`).

Aturan dependensi (design.md §20, keputusan #37) — hafalkan ini:

```
kiseki/src/registry.ts  →  upstream-core + SEMUA provider package   (satu-satunya pengecualian)
kiseki (logika lain)    →  upstream-core SAJA
upstream-<provider>     →  upstream-core SAJA
```

---

## 2. Butuh Package Sendiri, atau Cukup `generic`?

**`upstream-generic` adalah fallback config-driven** — tanpa satu pun hook.
Cek dulu daftar ini; kalau semuanya "tidak", providermu tidak butuh package baru:

- [ ] Provider punya **unit cost yang berbeda dari 1 kredit per request** dan
      angkanya stabil layak jadi default package?
- [ ] Provider punya **pesan error khas** yang tidak tertangkap tabel fallback
      di `upstream-core/src/capsig.ts` (mis. gate paket berbayar)?
- [ ] Provider **menuntut header tambahan** pada setiap request?
- [ ] Provider **menghitung batch JSON-RPC sebagai 1 request** (bukan per item)?
- [ ] Provider punya protokol yang benar-benar menyimpang dari JSON-RPC-over-HTTP?

Kalau **ya** untuk salah satunya → buat package tipis (tutorial di bawah).
Kalau **semua tidak** → cukup pakai `package: generic` di config, selesai.
Contoh nyata: `ankr-ethereum` di `kiseki.yaml` berjalan dengan `generic`.

> Catatan: mulailah dengan `generic` dulu. Buat package baru **hanya setelah**
> kamu melihat error/perilaku provider yang tidak tertangani — jangan spekulatif.

---

## 3. Anatomi Package

```
packages/upstream-ankr/
├── package.json          # pola tetap (lihat di bawah)
├── tsconfig.json         # extends ../../tsconfig.base.json
├── src/
│   └── index.ts          # SATU file: ekspor createAdapter (pola thin package)
└── test/
    └── ankr.test.ts      # test colocated (bun test packages/upstream-ankr)
```

`package.json` — salin pola ini:

```json
{
  "name": "upstream-ankr",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "upstream-core": "workspace:*"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

**Satu-satunya ekspor wajib**: `createAdapter: AdapterFactory` — signature:

```ts
type AdapterFactory = (cfg: UpstreamInstanceConfig, deps: CoreDeps) => UpstreamAdapter
```

Karena hampir semua kebutuhan ditutup `createPoolAdapter`, isi `src/index.ts`
umumnya hanya: tabel cost (opsional), matcher error (opsional), dan satu baris
pemanggilan `createPoolAdapter`.

---

## 4. Tutorial: Membuat `upstream-ankr` dari Nol

Latar fiktif: kita mau default cost Ankr per metode, dan menandai signature
error khas Ankr yang tidak tertangkap fallback generik. (Di repo nyata, Ankr
saat ini cukup pakai `generic` — tutorial ini sengaja melampauinya untuk
mengajarkan proses lengkap. **Pola regex di bawah ilustratif**: verifikasi
dulu pesan error asli provider sebelum dipakai.)

### Langkah 1 — Scaffold

Buat `packages/upstream-ankr/` dengan `package.json`, `tsconfig.json` (§3),
folder `src/` dan `test/`, lalu `bun install` dari root agar workspace
terdaftar.

### Langkah 2 — Tulis `src/index.ts`

```ts
/**
 * `upstream-ankr` — thin provider package for Ankr (design.md §7.3).
 *
 * Kustomisasi yang benar-benar khas Ankr, dan tidak di tempat lain:
 *  - tabel cost default Ankr (di sini: contoh, bukan angka resmi),
 *  - signature error Ankr yang tidak tertangkap tabel fallback generik.
 *
 * URL template TETAP dari config (`url_template`) karena per network
 * (eth, base, …) dan milik deployment, bukan milik package.
 */

import {
  createPoolAdapter,
  isMethodNotFound,
  type AdapterFactory,
  type CapabilityErrorMatcher,
  type CostTable,
} from "upstream-core"

/** Contoh tabel cost Ankr — VERIFIKASI terhadap dokumentasi resmi Ankr. */
export const ANKR_COSTS: CostTable = {
  eth_call: 1,
  eth_getLogs: 2,
  "trace_*": 5,
  "debug_*": 5,
}

/**
 * Signature khas Ankr di atas tabel fallback generik (design.md §8.3).
 * Return "method" | "archive" = mismatch terbukti → runtime note + regroup
 * (keputusan #34). Return null = "bukan error capability saya" → fallback
 * generik tetap jalan, lalu kalau tetap null → domain error final (#36).
 *
 * PENTING: pattern di bawah ILLUSTRATIF. Ambil dari respons error Ankr
 * yang sebenarnya (uji manual dengan apikey tanpa akses fitur X).
 */
const RATE_PLAN_PATTERN = /(?:method not allowed for your (?:plan|tier)|upgrade your plan)/

export const matchAnkrCapability: CapabilityErrorMatcher = (error) => {
  if (isMethodNotFound(error)) return "method"          // redundan vs fallback, eksplisit
  if (RATE_PLAN_PATTERN.test(error.message.toLowerCase())) return "method"
  return null   // sisanya → fallback generik di upstream-core
}

export const createAdapter: AdapterFactory = (cfg, deps) =>
  createPoolAdapter(cfg, deps, {
    costs: ANKR_COSTS,
    matchCapability: matchAnkrCapability,
  })
```

Yang **tidak perlu** ditulis di package provider (semua sudah di engine):

- pemilihan apikey & weighted-random → `ApikeyPool`
- deduct kuota sync sebelum fetch, per item batch → `ApikeyPool`
- cooldown & health per apikey/provider → `ApikeyPool`
- klasifikasi HTTP 429/5xx/timeout/batch → `classifyResponse`/`classifyBody`
- URL dari `{apikey}` → otomatis dari `cfg.url_template`
- timeout → `cfg.timeout_ms` / classifier (§14)

### Langkah 3 — Register di Composition Root

Buka `packages/kiseki/src/registry.ts` dan tambah **dua baris** (import +
register) — lihat §9. Inilah seluruh "integrasi" ke Kiseki: tidak ada branch
baru di router/server/classifier, sesuai komentar composition root.

### Langkah 4 — Pakai di Config

Di `kiseki.yaml`, instance upstream cukup menunjuk `package: ankr` (§9.2).

### Langkah 5 — Test

Tulis `test/ankr.test.ts` memakai pola harness §8: verifikasi cost terpotong
sesuai tabel, override config menang atas default package, dan signature error
Ankr terdeteksi. Jalankan: `bun test packages/upstream-ankr`.

---

## 5. Referensi Lengkap: `AdapterHooks`

Kustomisasi package provider berbentuk hooks ketiga dari `createPoolAdapter`
(`upstream-core/src/pool.ts`). Semua opsional:

```ts
export type AdapterHooks = {
  /** Signature error provider, berlapis di atas tabel fallback generik (§8.3). */
  matchCapability?: CapabilityErrorMatcher

  /**
   * Tabel cost default provider. Ini lapisan TENGAH: config instance
   * (`costs:`) mengalahkannya, dan hanya setelah itu global `defaults.costs`
   * berlaku (design.md §5.3). Lihat §6.
   */
  costs?: CostTable

  /** Header tambahan per token (quirk provider). Dipanggil per attempt. */
  headers?(token: string): Record<string, string>

  /** Provider yang menagih per HTTP call, bukan per item batch (§5.5 rule 2). */
  countsBatchAsOne?: boolean

  /**
   * Observer level-2 (attempt per apikey, failover, latensi, mismatch).
   * Default-nya diisi dari `deps.poolObserver` oleh composition root —
   * isi ini HANYA untuk kasus khusus (mis. test), bukan untuk metrics normal.
   */
  observer?: PoolObserver

  /** Seam test untuk weighted-random. Default Math.random. Jangan diisi di prod. */
  random?(): number
}
```

Dua tipe penunjang yang mungkin kamu butuhkan:

```ts
// capsig.ts — signature capability (lihat §7)
type CapabilityErrorMatcher = (error: JsonRpcError, isHistorical: boolean) =>
  "method" | "archive" | null

// adapter.ts — apa yang diterima factory
type CoreDeps = {
  bucketRegistry: BucketRegistry   // bucket shared per (provider, token), #24
  logger: Logger                   // JANGAN pernah log token apikey
  now(): number                    // injeksi clock (deterministik di test)
  fetchImpl?: typeof fetch         // override test
  globalCosts?: CostTable          // layer bawah cost (defaults.costs)
  poolObserver?: PoolObserver      // seam observability process-wide
}
```

`UpstreamInstanceConfig` (dari config YAML, `adapter.ts`) berisi antara lain:
`name`, `provider`, `package`, `url_template` (wajib memuat `{apikey}`),
`apikeys[]` (token+label+buckets), `methods` (pola, wildcard `*` trailing
saja), `archive`, `costs?`, `counts_batch_as_one_request?`, `timeout_ms?`.

**Kapan implementasi `UpstreamAdapter` manual (tanpa `createPoolAdapter`)?**
Hampir tidak pernah. Hanya untuk provider dengan protokol yang benar-benar
menyimpang dari JSON-RPC-over-HTTP. Kalau terpaksa: implement keempat method
interface (`capability`, `weight`, `earliestReadyAt`, `attempt`) dan pertahankan
semantik outcome taxonomy persis seperti yang dijanjikan `ApikeyPool` —
terutama deduct-sebelum-fetch dan `ambiguous` STOP TOTAL untuk sendRaw.

---

## 6. Lapisan Cost

Cost sebuah metode diselesaikan berlapis — **lapisan utuh menang**, bukan merge
per-key (`upstream-core/src/cost.ts`, design.md §5.3):

```
cfg.costs (config instance)  →  hooks.costs (default package)  →
deps.globalCosts (defaults.costs)  →  implisit 1
```

Artinya penting untuk desain tabel package-mu:

- `costs` di hooks adalah **default provider**, bukan kebenaran abadi — config
  instance selalu bisa meng-override (escape hatch ketika provider mengubah
  angka, design.md §23 risiko #8).
- Metode yang TIDAK dikenal lapisan package tetap bisa jatuh ke lapisan global
  (mis. `trace_*: 5` global) — jadi jangan isi entri wildcard yang menutupi
  metode yang sebenarnya ingin diserahkan ke global.
- Kunci tabel: nama metode persis ATAU pola trailing-wildcard (`trace_*`);
  exact menang atas prefix, prefix terpanjang menang antar prefix.
- Angka 0 sah (metode gratis seperti `eth_chainId` di Alchemy).

Sumber angka: kutip dokumen resmi provider + tanggal baca di komentar
(contoh: header komentar `ALCHEMY_CU` di `upstream-alchemy`).

---

## 7. Signature Capability-Mismatch

Latar: mismatch capability yang terbukti runtime **bukan error final** — item
di-regroup dan dicoba ke upstream lain (keputusan #34–35). Package provider
ikut menentukan *apa yang dihitung mismatch* lewat `matchCapability`.

Semantik return:

| Return | Arti | Efek |
|---|---|---|
| `"method"` | terbukti tidak bisa melayani metode itu | runtime note + regroup item |
| `"archive"` | terbukti non-archive / state historis tak tersedia | runtime note + regroup item |
| `null` | "bukanCapability saya" | **fallback generik tetap dijalankan** (`composeMatchers`), dan kalau juga null → domain error final ke klien (#36) |

Tabel fallback generik (`upstream-core/src/capsig.ts`) sudah menangkap:
`-32601` → `method`; pola state (`missing trie node`, `state pruned`,
`archive node`, …) → `archive`; pola block-not-found **untuk query historis
saja** (parameter `isHistorical`) → `archive`.

Praktis untuk package provider:

- **Tambah, jangan menimpa**: return `null` untuk semua yang bukan khas
  provider-mu — fallback tetap berjalan setelahmu.
- **Jangan agresif**: error domain node (`execution reverted`, `nonce too low`,
  `insufficient funds`) **wajib** berujung `null` → diteruskan final apa adanya
  ke klien. Salah satu-satunya match di sini = regroup percuma + kuota hangus.
- Sifat case-insensitive: fallback meng-lowercase `message + data`. Untuk
  matcher-mu sendiri, ikuti kebiasaan yang sama (`toLowerCase()`).
- Setiap match otomatis tercatat `kiseki_capability_regroups_total{cap=…}` dan
  log warn — kamu tidak perlu menambah metric sendiri.

---

## 8. Testing

Test **colocated** di `packages/upstream-ankr/test/`. Pola harness yang sudah
dibuktikan (lihat `upstream-alchemy/test/alchemy.test.ts`): injeksi
`BucketRegistry` + `fetchImpl` + `now()` statis → deterministik, tanpa mock
timer, tanpa jaringan.

```ts
import { describe, expect, test } from "bun:test"
import {
  BucketRegistry, silentLogger,
  type Group, type UpstreamInstanceConfig,
} from "upstream-core"
import { createAdapter } from "../src/index"

const cfg: UpstreamInstanceConfig = {
  name: "ankr-ethereum",
  provider: "ankr",
  package: "ankr",
  url_template: "https://rpc.ankr.com/eth/{apikey}",
  apikeys: [{ token: "KEY_A", label: "main",
              buckets: [{ capacity: 1000, refill_per_second: 10 }] }],
  methods: ["eth_*"],
  archive: false,
}

const group = (method: string): Group => ({
  chain: "ethereum",
  items: [{ originalIndex: 0, id: 0, method, params: [], historical: false }],
  needsArchive: false,
  idempotency: "READ",
  timeoutMs: 1_000,
})

const ctx = { attempt: 0, logger: silentLogger, now: () => 0 }

const okBody = (id: number) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }))

test("cost default package terpotong; override config menang", async () => {
  const registry = new BucketRegistry(() => 0)
  const adapter = createAdapter(cfg, {
    bucketRegistry: registry,
    logger: silentLogger,
    now: () => 0,
    fetchImpl: (async () => okBody(0)) as unknown as typeof fetch,
  })
  await adapter.attempt(group("eth_getLogs"), ctx)
  expect(registry.peek("ankr", "KEY_A")!.credits(0)).toEqual([998]) // 1000 - 2
})
```

Skenario minimum yang wajib ada di package provider:

1. **Cost**: default package terpotong benar; `costs:` config instance
   mengalahkannya; lapisan global hanya mengisi metode yang tak dikenal.
2. **Signature**: error khas provider-mu → cap yang benar; error domain
   (`execution reverted` dsb.) → lolos tanpa match (null).
3. **Quirks** (bila ada): header benar terkirim; `countsBatchAsOne` berjalan.

Jalankan per package: `bun test packages/upstream-ankr`. Seluruh monorepo:
`bun test` (hijau penuh adalah syarat PR — §10).

---

## 9. Menghubungkan ke Kiseki (Composition Root + Config)

### 9.1 Register di composition root

`packages/kiseki/src/registry.ts` adalah **satu-satunya** file di package
`kiseki` yang boleh meng-import provider package (keputusan #37). Tambahkan
import + satu `register` — tidak ada perubahan lain di mana pun:

```ts
import { createAdapter as createAnkrAdapter } from "upstream-ankr"

export const PACKAGE_ANKR = "ankr"

export function buildRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(PACKAGE_GENERIC, createGenericAdapter)
  registry.register(PACKAGE_ALCHEMY, createAlchemyAdapter)
  registry.register(PACKAGE_ANKR, createAnkrAdapter)   // ← satu baris baru
  return registry
}
```

Nama yang diregister = nilai yang sah untuk config `package:`. Nilai yang tidak
teregister → error startup (bukan silent fallback).

### 9.2 Pakai di `kiseki.yaml`

```yaml
chains:
  ethereum:
    upstreams:
      - name: ankr-ethereum
        provider: ankr                  # identitas sharing bucket (§5.4)
        package: ankr                   # ← baru ini yang berubah dari "generic"
        url_template: "https://rpc.ankr.com/eth/{apikey}"
        apikeys:
          - token: "${ANKR_KEY}"
            label: main
            buckets:
              - { capacity: 15,  refill_per_second: 15 }    # RPS
              - { capacity: 600, refill_per_second: 10 }    # RPM
        methods: ["eth_*"]
        archive: false
```

Ingat semantik dua field identitas:

- `provider:` = kunci sharing bucket lintas chain (#24) — apikey sama di dua
  chain dengan `provider` sama = satu bucket bersama.
- `package:` = adapter mana yang membangun instance ini (§9.1).

### 9.3 Verifikasi akhir

```bash
bun install                      # daftarkan workspace baru
bun test                         # seluruh suite hijau
bun run --filter kiseki build    # binary tunggal tetap terbangun
```

Uji manual dengan config `kiseki.yaml` milikmu: metode yang provider baru
bisa melayani harus jalan; metode yang tidak → `-32601` pre-flight (config
statis) atau regroup ke upstream lain (runtime, #34).

---

## 10. Checklist PR

- [ ] `src/index.ts` mengekspor `createAdapter: AdapterFactory` (satu file,
      tanpa logika routing)
- [ ] `package.json` mengikuti pola §3; hanya dep `upstream-core`
- [ ] Tidak ada file di luar package yang berubah **kecuali**
      `packages/kiseki/src/registry.ts` (dua baris) — bila lebih, jelaskan kenapa
- [ ] Tabel cost: sumber resmi dikutip + tanggal baca; angka 0 sah untuk metode gratis
- [ ] `matchCapability`: error domain → `null`; tidak ada pattern agresif yang
      bisa menelan domain error
- [ ] Test: cost + signature (+ quirks bila ada) dengan harness injeksi §8;
      `bun test` hijau penuh
- [ ] Tidak ada token apikey yang di-log / ditulis / di-echo di manapun (§11)
- [ ] Contoh config di `kiseki.yaml` (atau docs) memakai `${VAR}`, bukan token mentah
- [ ] Dokumen desain tak tersentuh; kalau ada kebutuhan di luar kontrak
      `AdapterHooks`, itu **desain baru** → usulkan revisi `design.md` dulu
      (preamble design.md), bukan trik di package

## 11. Aturan yang Tidak Boleh Dilanggar

1. **Jangan pernah log token apikey** — hanya `label`. Logger di-inject;
   token tidak pernah masuk log/error/metric (design.md §18.2).
2. **Deduct terjadi sebelum fetch, tanpa refund** — sudah dijamin engine;
   implementasi manual pun wajib mempertahankannya (§5.5).
3. **`ambiguous` (sendRaw) STOP TOTAL** — tidak boleh ada jalur retry di level
   package untuk hasil ambigu (§11.3).
4. **Domain error passthrough** — jawaban node benar tidak boleh di-retry
   atau diubah (keputusan #36).
5. **Dependensi satu arah** — provider package hanya boleh meng-import
   `upstream-core`; tidak boleh meng-import `kiseki` atau package provider lain.
6. **Config statis adalah sumber capability** — runtime matcher hanya
   koreksi; jangan pakai untuk "menebak" capability saat startup.
