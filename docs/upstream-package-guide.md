# Panduan Contributor: Membuat Upstream Package Baru

> Tutorial praktis untuk contributor yang ingin menambahkan dukungan provider RPC
> baru ke Kiseki. Untuk gambaran arsitektur — routing dua level, model kuota,
> kebijakan error — baca `ARCHITECTURE.md` di akar repositori.
>
> Dokumen ini ditulis terhadap kode yang ada di repositori ini, bukan terhadap
> rencana. Setiap potongan kode di bawah berasal dari berkas nyata; nama berkas
> disebut supaya mudah dicocokkan.
>
> Referensi nyata di repo: `packages/upstream-generic` (nol kustomisasi),
> `packages/upstream-alchemy` (cost table + signature error), dan
> `packages/upstream-ankr` (cost table + signature + translasi `kiseki_*`).

---

## Daftar Isi

1. [Cara Provider Muat ke Arsitektur](#1-cara-provider-muat-ke-arsitektur)
2. [Butuh Package Sendiri, atau Cukup `generic`?](#2-butuh-package-sendiri-atau-cukup-generic)
3. [Anatomi Package](#3-anatomi-package)
4. [Tutorial: Membuat `upstream-example` dari Nol](#4-tutorial-membuat-upstream-example-dari-nol)
5. [Referensi Lengkap: `AdapterHooks`](#5-referensi-lengkap-adapterhooks)
   — termasuk [5.1 Melayani namespace kanonik `kiseki_*`](#51-melayani-namespace-kanonik-kiseki_)
6. [Lapisan Cost](#6-lapisan-cost)
7. [Signature Capability-Mismatch](#7-signature-capability-mismatch)
8. [Testing](#8-testing)
9. [Menghubungkan ke Kiseki (Composition Root + Config)](#9-menghubungkan-ke-kiseki-composition-root--config)
10. [Checklist PR](#10-checklist-pr)
11. [Aturan yang Tidak Boleh Dilanggar](#11-aturan-yang-tidak-boleh-dilanggar)

---

## 1. Cara Provider Muat ke Arsitektur

Kiseki melakukan routing **dua level**:

```
Client → kiseki (router level 1) → upstream package (provider) → ApikeyPool → provider RPC
```

Sebuah **upstream package** adalah lapisan tipis milik satu provider. Ia tidak
berisi logika routing — semua logika pool (weighted-random apikey, potong kuota,
cooldown, klasifikasi hasil) sudah ada di `upstream-core`. Yang tersisa untuk
package provider hanyalah **keunikan provider itu**:

| Keunikan | Contoh |
|---|---|
| Tabel cost default | CU asli Alchemy (`ALCHEMY_CU`) |
| Signature error khas | kode `-32075` "Method disabled" milik Ankr |
| Header wajib | beberapa provider menuntut header khusus |
| Bill per HTTP call | provider yang menghitung batch sebagai 1 request |
| Tabel translasi kanonik | `kiseki_*` → `ankr_*` |

Kontrak yang dilihat router — ia **tidak pernah** tahu detail internal package —
ada di `packages/upstream-core/src/adapter.ts`:

```ts
export interface UpstreamAdapter {
  readonly name: string
  readonly provider: string

  capability(): Capability
  weight(): number
  earliestReadyAt(): number
  attempt(group: Group, ctx: AttemptCtx): Promise<UpstreamOutcome>
}
```

Aturan dependensi — hafalkan ini:

```
packages/kiseki/src/registry.ts  →  upstream-core + SEMUA provider package   (satu-satunya pengecualian)
kiseki (logika lain)             →  upstream-core SAJA
upstream-<provider>              →  upstream-core SAJA
```

`packages/kiseki/src/registry.ts` adalah satu-satunya berkas di paket `kiseki`
yang boleh meng-import provider package. Router, server, classifier, dan pipeline
bekerja terhadap `UpstreamAdapter`, sehingga menambah provider tidak menyentuh
lapisan routing sama sekali.

---

## 2. Butuh Package Sendiri, atau Cukup `generic`?

**`upstream-generic` adalah fallback config-driven** — tanpa satu pun hook:

```ts
export const createAdapter: AdapterFactory = (cfg, deps) => createPoolAdapter(cfg, deps)
```

Cek dulu daftar ini; kalau semuanya "tidak", providermu tidak butuh package baru:

- [ ] Provider punya **unit cost yang berbeda dari 1 kredit per request** dan
      angkanya stabil layak jadi default package?
- [ ] Provider punya **pesan atau kode error khas** yang tidak tertangkap tabel
      fallback generik di `packages/upstream-core/src/capsig.ts` (mis. gate
      paket berbayar)?
- [ ] Provider **menuntut header tambahan** pada setiap request?
- [ ] Provider **menghitung batch JSON-RPC sebagai 1 request** (bukan per item)?
- [ ] Provider punya method non-standar yang ingin diekspos lewat `kiseki_*`?
- [ ] Provider punya protokol yang benar-benar menyimpang dari JSON-RPC-over-HTTP?

Kalau **ya** untuk salah satunya → buat package tipis (tutorial di bawah).
Kalau **semua tidak** → cukup pakai `package: generic` di config, selesai.

Perhatikan bahwa `generic` **tidak** bisa menangani dua hal: signature error khas
provider (tidak ada field regex di skema config) dan translasi `kiseki_*`. Keduanya
butuh package.

Contoh nyata di repo ini:

- `ankr-ethereum-node` (node API Ankr) → cukup `package: generic`: tidak ada cost
  khusus, tidak ada signature khusus.
- `ankr-ethereum-aapi` (Advanced API Ankr) → `package: ankr`: 700 API
  Credits/request, satu signature gate khas (`-32075`), dan tabel translasi
  `kiseki_*`.

> Catatan: mulailah dengan `generic` dulu. Buat package baru **hanya setelah**
> kamu melihat error/perilaku provider yang tidak tertangani — jangan spekulatif.

---

## 3. Anatomi Package

```
packages/upstream-example/
├── package.json          # pola tetap (lihat di bawah)
├── tsconfig.json         # extends ../../tsconfig.base.json
├── src/
│   └── index.ts          # SATU file: ekspor createAdapter (pola thin package)
└── test/
    └── example.test.ts   # test colocated (bun test packages/upstream-example)
```

`package.json` — salin pola ini:

```json
{
  "name": "upstream-example",
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
umumnya hanya: tabel cost (opsional), matcher error (opsional), tabel translasi
(opsional), dan satu baris pemanggilan `createPoolAdapter`.

---

## 4. Tutorial: Membuat `upstream-example` dari Nol

Latar: kita mau default cost per metode untuk provider khayalan `example`, dan
menandai satu signature error khasnya. Nama dan angkanya sengaja generik supaya
tidak ada yang terkecoh mengira itu angka resmi.

> **Pola regex di bawah ilustratif.** Jangan pakai pola error dari dokumen mana
> pun tanpa memverifikasinya ke respons asli provider. Lihat §7 untuk contoh
> kesalahan yang pernah terjadi di proyek ini.

### Langkah 1 — Scaffold

Buat `packages/upstream-example/` dengan `package.json`, `tsconfig.json` (§3),
folder `src/` dan `test/`, lalu `bun install` dari root agar workspace terdaftar.

### Langkah 2 — Tulis `src/index.ts`

```ts
/**
 * `upstream-example` — thin provider package for the fictional "example" provider.
 *
 * Yang benar-benar khas provider ini, dan tidak ada di tempat lain:
 *  - tabel cost default provider,
 *  - signature error yang tidak tertangkap tabel fallback generik.
 *
 * URL template TETAP dari config (`url_template`) karena per network dan milik
 * deployment, bukan milik package.
 */

import {
  createPoolAdapter,
  isMethodNotFound,
  type AdapterFactory,
  type CapabilityErrorMatcher,
  type CostTable,
} from "upstream-core"

/** Tabel cost contoh — VERIFIKASI terhadap dokumentasi resmi provider. */
export const EXAMPLE_COSTS: CostTable = {
  eth_call: 1,
  eth_getLogs: 2,
  "trace_*": 5,
  "debug_*": 5,
}

/**
 * Signature khas provider, berlapis di atas tabel fallback generik.
 * Return "method" | "archive" = mismatch terbukti → runtime note + regroup.
 * Return null = "bukan error capability saya" → fallback generik tetap jalan,
 * lalu kalau tetap null → domain error final ke klien.
 *
 * PENTING: pattern di bawah ILLUSTRATIF. Ambil dari respons error provider yang
 * sebenarnya (uji manual dengan apikey tanpa akses fitur X).
 */
const PLAN_GATED_PATTERN = /(?:method not allowed for your (?:plan|tier)|upgrade your plan)/

export const matchExampleCapability: CapabilityErrorMatcher = (error) => {
  if (isMethodNotFound(error)) return "method"          // redundan vs fallback, eksplisit
  if (PLAN_GATED_PATTERN.test(error.message.toLowerCase())) return "method"
  return null   // sisanya → fallback generik di upstream-core
}

export const createAdapter: AdapterFactory = (cfg, deps) =>
  createPoolAdapter(cfg, deps, {
    costs: EXAMPLE_COSTS,
    matchCapability: matchExampleCapability,
  })
```

Yang **tidak perlu** ditulis di package provider (semua sudah di engine):

- pemilihan apikey & weighted-random → `ApikeyPool`
- potong kuota sinkron sebelum fetch, per item batch → `ApikeyPool`
- cooldown & health per apikey/provider → `ApikeyPool`
- klasifikasi HTTP 429/5xx/timeout/batch → `classifyResponse`/`classifyBody`
- URL dari `{apikey}` → otomatis dari `cfg.url_template`
- timeout → `cfg.timeout_ms` atau timeout kelas metode dari classifier

### Langkah 3 — Register di Composition Root

Buka `packages/kiseki/src/registry.ts` dan tambah **dua baris** (import +
register) — lihat §9. Inilah seluruh "integrasi" ke Kiseki: tidak ada branch baru
di router/server/classifier.

### Langkah 4 — Pakai di Config

Di `kiseki.yaml`, instance upstream cukup menunjuk `package: example` (§9.2).

### Langkah 5 — Test

Tulis `test/example.test.ts` memakai pola harness §8: verifikasi cost terpotong
sesuai tabel, override config menang atas default package, dan signature error
provider terdeteksi. Jalankan: `bun test packages/upstream-example`.

---

## 5. Referensi Lengkap: `AdapterHooks`

Kustomisasi package provider berbentuk hooks ketiga dari `createPoolAdapter`
(`packages/upstream-core/src/pool.ts`). Semua opsional:

```ts
export type AdapterHooks = {
  /** Signature error provider, berlapis di atas tabel fallback generik (§7). */
  matchCapability?: CapabilityErrorMatcher

  /**
   * Tabel cost default provider. Ini lapisan TENGAH: config instance (`costs:`)
   * mengalahkannya, dan hanya setelah itu global `defaults.costs` berlaku.
   * Lihat §6.
   */
  costs?: CostTable

  /** Header tambahan per token (quirk provider). Dipanggil per attempt. */
  headers?(token: string): Record<string, string>

  /** Provider yang menagih per HTTP call, bukan per item batch. */
  countsBatchAsOne?: boolean

  /**
   * Observer level-2 (attempt per apikey, failover, latensi, mismatch).
   * Default-nya diisi dari `deps.poolObserver` oleh composition root —
   * isi ini HANYA untuk kasus khusus (mis. test), bukan untuk metrics normal.
   */
  observer?: PoolObserver

  /** Seam test untuk weighted-random. Default Math.random. Jangan diisi di prod. */
  random?(): number

  /**
   * Tabel translasi namespace kanonik `kiseki_*` → method provider asli.
   * Kosong/absen = package ini tidak melayani method kanonik (lihat §5.1).
   */
  translations?: readonly MethodTranslation[]
}
```

`countsBatchAsOne` dari hooks kalah oleh `counts_batch_as_one_request` di config
instance, karena satu instance bisa menunjuk package yang sama dengan setelan
berbeda.

`CoreDeps` — apa yang diterima factory dari composition root:

```ts
type CoreDeps = {
  bucketRegistry: BucketRegistry   // bucket shared per (provider, token)
  logger: Logger                   // JANGAN pernah log token apikey
  now(): number                    // injeksi clock (deterministik di test)
  fetchImpl?: typeof fetch         // override test
  globalCosts?: CostTable          // layer bawah cost (defaults.costs)
  poolObserver?: PoolObserver      // seam observability process-wide
}
```

`UpstreamInstanceConfig` (dari config YAML, `adapter.ts`) berisi:
`name`, `provider`, `package`, `url_template` (wajib memuat `{apikey}`),
`apikeys[]` (token + label + buckets), `methods` (pola, wildcard `*` trailing
saja), `archive`, `costs?`, `counts_batch_as_one_request?`, `timeout_ms?`.

**Kapan implementasi `UpstreamAdapter` manual (tanpa `createPoolAdapter`)?**
Hampir tidak pernah. Hanya untuk provider dengan protokol yang benar-benar
menyimpang dari JSON-RPC-over-HTTP. Kalau terpaksa: implement keempat method
interface dan pertahankan semantik outcome taxonomy persis seperti yang dijanjikan
`ApikeyPool` — terutama potong-sebelum-fetch dan `ambiguous` yang menghentikan
total untuk sendRaw.

### 5.1 Melayani namespace kanonik `kiseki_*`

Provider punya method non-standar sendiri (`ankr_*`, `alchemy_*`, …). Client
sebaiknya cukup menghafal satu namespace netral: `kiseki_*`. Package provider
menyuplai tabel translasi, engine yang menjalankan pemetaannya — router kiseki
**tidak berubah sama sekali**.

Kontrak `MethodTranslation` (`packages/upstream-core/src/namespace.ts`):

```ts
export type MethodTranslation = {
  canonical: string    // "kiseki_getTokenTransfers"
  upstream: string     // "ankr_getTokenTransfers"
  /** Params kanonik → params provider. `undefined` = params client invalid. */
  mapRequest(params: readonly unknown[], chain: string): unknown | undefined
  /** Hasil provider → hasil kanonik. Hanya untuk respons sukses. */
  mapResponse(result: unknown, params: readonly unknown[], chain: string): unknown
  /** Default "jsonrpc". "http" belum diimplementasi (lihat di bawah). */
  transport?: "jsonrpc" | "http"
}
```

Contoh pemakaian:

```ts
import { parseCanonicalParams, type MethodTranslation } from "upstream-core"

export const TRANSLATIONS: readonly MethodTranslation[] = [
  {
    canonical: "kiseki_getTokenTransfers",
    upstream: "example_getTokenTransfers",
    // params kanonik → params provider. `undefined` = params client invalid.
    mapRequest: (params, chain) => {
      const parsed = parseCanonicalParams("kiseki_getTokenTransfers", params)
      if (parsed === undefined) return undefined
      const network = NETWORK_ALIASES[chain]        // ethereum → eth
      if (network === undefined) return undefined   // jangan menebak
      // Bentuk params upstream BEBAS: array posisional (node API) atau objek
      // bernama (mis. Advanced API). Ikuti docs provider, bukan tebakan.
      return { network, address: parsed.address }
    },
    // result provider → result kanonik. Hanya respons sukses.
    // `chain` = chain kiseki yang di-route (argumen ketiga), bukan tebakan dari
    // payload: halaman kosong tidak punya field apa pun untuk ditebak.
    mapResponse: (result, params, chain) => ({ /* …bentuk kanonik, sertakan `chain`… */ }),
  },
]

export const createAdapter: AdapterFactory = (cfg, deps) =>
  createPoolAdapter(cfg, deps, { costs: COSTS, translations: TRANSLATIONS })
```

Kaidah yang dijamin engine (jangan diduplikasi di package):

| Perilaku | Siapa yang mengerjakan |
|---|---|
| `capability()` mencakup `kiseki_*` | otomatis, **hanya** kalau `upstream`-nya cocok pola `methods:` config |
| Body request memakai method+params provider | engine, sebelum tiap attempt |
| Cost memakai **nama upstream** (mis. `ankr_get*` = 700) | engine (`itemCost`) |
| `mapRequest → undefined` = domain error final, tanpa fetch/regroup | engine |
| Bentuk `params` upstream (array atau objek) diteruskan apa adanya | engine (`buildRequests`) |
| Error provider **tidak** diterjemahkan (passthrough) | engine |
| `mapResponse` throw = domain error final, tidak failover | engine |
| Skema param/result kanonik (strict, Zod) | `packages/upstream-core/src/namespace.ts` |
| `chain` diteruskan ke `mapResponse` | engine (`pool.ts`, argumen ketiga) |

Konsekuensi yang perlu disadari:

- **Coverage = per (provider × plan).** Method kanonik hanya diiklankan kalau
  method upstream-nya ada di `methods:`. Plan lebih rendah → kurangi entri
  translasi (atau sempitkan `methods:`), core tak berubah.
- **Pemetaan harus murni** — tanpa I/O, tanpa cache. `mapRequest`/`mapResponse`
  dipanggil di jalur request.
- **`mapRequest` boleh mengembalikan objek.** JSON-RPC 2.0 mengizinkan `params`
  berupa array posisional ATAU objek bernama; engine meneruskannya verbatim.
  Pakai bentuk yang **didokumentasikan provider** — jangan mengandalkan toleransi
  server. (Ankr AAPI menerima array hari ini karena servernya mengambil elemen
  pertama, tapi docs-nya mendokumentasikan objek.)
- **Hati-hati batas `pageSize` provider.** Kalau batas provider LEBIH KECIL dari
  maksimum kanonik (1000), tolak di `mapRequest` (`return undefined`) — jangan
  di-clamp diam-diam. Clamp mengubah makna permintaan client, dan percobaan yang
  pasti gagal tetap dibayar penuh (Ankr: 700 kredit). Contoh:
  `ankr_getNFTsByOwner` maks 50.
- **Jangan memakai `number` JS untuk nilai Wei.** Pakai `tokenAmountFromRaw(hex)`
  → `{ value, valueRaw }` (string desimal + hex asli). Kalau provider memberi
  integer **desimal** (bukan hex), konversi sendiri ke hex untuk `valueRaw` —
  jangan tempelkan angka desimal ke field bernama "hex".
- **`mapResponse` menerima `chain` sebagai argumen ketiga.** Semua skema hasil
  kanonik mewajibkan field `chain`, sedangkan payload provider sering tidak
  memuatnya (dan halaman kosong tidak memuat apa pun). Jangan menebak chain dari
  payload; pakai argumen itu.
- **`transport: "http"` (REST) belum diimplementasi.** Entri seperti itu tidak
  diiklankan di `capability()`, dan bila tetap terpanggil dijawab `-32603` tanpa
  mengirim request. Hanya `"jsonrpc"` (default) yang jalan. Jangan menulis entri
  REST sebelum engine-nya ada — ia akan tampak seperti fitur yang tidak pernah
  aktif.

Enam method kanonik yang sudah didefinisikan:

| Method kanonik | Dilayani oleh |
|---|---|
| `kiseki_getTokenTransfers` | `upstream-ankr` |
| `kiseki_getTransactionsByAddress` | `upstream-ankr` |
| `kiseki_getAccountBalance` | `upstream-ankr` |
| `kiseki_getNFTsByOwner` | `upstream-ankr` |
| `kiseki_getNFTMetadata` | `upstream-ankr` |
| `kiseki_getTokenPrice` | `upstream-ankr` |

**Contoh nyata: `packages/upstream-ankr`** — baca berkas itu sebelum menulis
translasimu sendiri; beberapa jebakannya tidak terduga:

- `kiseki_getNFTsByOwner` → `ankr_getNFTsByOwner` butuh `filter` berbentuk
  **array** `[{ "<contract>": [] }]`. Object polos ditolak `-32602`.
- Ankr mengembalikan `valueRawInteger` sebagai **desimal**; `valueRaw` kanonik
  harus hex. Selain itu field `value` Ankr terbukti bisa tidak konsisten dengan
  `valueRawInteger`-nya, jadi nilai kanonik diturunkan dari raw + decimals.
- `timestamp` Ankr = unix detik (kadang hex string); kanonik = ISO-8601.
- Nama chain Ankr (`eth`) berbeda dari nama kiseki (`ethereum`) — itulah
  satu-satunya alasan `ANKR_CHAIN_ALIASES` ada.

**Jangan menulis translasi dari ingatan.** Baca dokumen per metode, lalu rekam
bentuk respons nyata sebelum menulis `mapResponse`. Test harus memakai fixture
dari respons sungguhan, bukan bentuk yang kamu bayangkan.

---

## 6. Lapisan Cost

Cost sebuah metode diselesaikan berlapis — **lapisan utuh menang**, bukan merge
per-key (`packages/upstream-core/src/cost.ts`):

```
cfg.costs (config instance)  →  hooks.costs (default package)  →
deps.globalCosts (defaults.costs)  →  implisit 1
```

Artinya penting untuk desain tabel package-mu:

- `costs` di hooks adalah **default provider**, bukan kebenaran abadi — config
  instance selalu bisa meng-override. Ini escape hatch ketika provider mengubah
  angka.
- Metode yang TIDAK dikenal lapisan package tetap bisa jatuh ke lapisan global
  (mis. `trace_*: 5` global) — jadi jangan isi entri wildcard yang menutupi
  metode yang sebenarnya ingin diserahkan ke global.
- Kunci tabel: nama metode persis ATAU pola trailing-wildcard (`trace_*`);
  exact menang atas prefix, prefix terpanjang menang antar prefix.
- Angka 0 sah (metode gratis seperti `eth_chainId` di Alchemy).
- Kunci dengan `*` di tengah ditolak saat validasi config, karena pola seperti
  itu tidak akan pernah cocok dan setiap panggilan akan diam-diam berharga 1.

Sumber angka: kutip dokumen resmi provider + tanggal baca di komentar (contoh:
header komentar `ALCHEMY_CU` di `packages/upstream-alchemy/src/index.ts`).

---

## 7. Signature Capability-Mismatch

Latar: mismatch capability yang terbukti runtime **bukan error final** — item
di-regroup dan dicoba ke upstream lain. Package provider ikut menentukan *apa
yang dihitung mismatch* lewat `matchCapability`.

Semantik return:

| Return | Arti | Efek |
|---|---|---|
| `"method"` | terbukti tidak bisa melayani metode itu | runtime note + regroup item |
| `"archive"` | terbukti non-archive / state historis tak tersedia | runtime note + regroup item |
| `null` | "bukan capability saya" | **fallback generik tetap dijalankan** (`composeMatchers`), dan kalau juga null → domain error final ke klien |

Tabel fallback generik (`packages/upstream-core/src/capsig.ts`) sudah menangkap:
`-32601` → `method`; pola state (`missing trie node`, `state pruned`,
`archive node`, …) → `archive`; pola block-not-found **untuk query historis
saja** (parameter `isHistorical`) → `archive`.

Matcher provider mendapat giliran pertama; `null` bukan veto, melainkan "bukan
milik saya", sehingga tabel generik tetap berjalan setelahnya.

Praktis untuk package provider:

- **Tambah, jangan menimpa**: return `null` untuk semua yang bukan khas
  provider-mu — fallback tetap berjalan setelahmu.
- **Jangan agresif**: error domain node (`execution reverted`, `nonce too low`,
  `insufficient funds`) **wajib** berujung `null` → diteruskan final apa adanya
  ke klien. Salah satu-satunya match di sini = regroup percuma + kuota hangus.
- **Perhatikan kode, bukan hanya pesan.** Sebagian provider memakai kode yang
  tidak lazim: Ankr membalas `-32075` "Method disabled" untuk metode yang ada
  tetapi dimatikan, dan Alchemy membalas `-32600` — bukan `-32601` — untuk
  metode yang tidak tersedia di tier-nya. `isMethodNotFound` hanya memeriksa
  `-32601`, jadi kode seperti itu harus ditangani eksplisit.
- Sifat case-insensitive: fallback meng-lowercase `message + data`. Untuk
  matcher-mu sendiri, ikuti kebiasaan yang sama (`toLowerCase()`).
- Setiap match otomatis tercatat `kiseki_capability_regroups_total{cap=…}` dan
  log warn — kamu tidak perlu menambah metric sendiri.

> **Pelajaran dari repo ini.** Pola `PLAN_GATED_PATTERN` di
> `packages/upstream-alchemy/src/index.ts` ditulis dari bayangan, bukan dari
> respons asli. Pesan Alchemy yang sebenarnya memakai "Free tier", "Pay As You
> Go", dan "PAYG", sedangkan pola itu menuntut "free plan", "paid plan", dan
> "upgrade to paid" — tidak ada yang cocok. Akibatnya metode yang sudah terbukti
> tidak bisa dilayani akan dicoba lagi selamanya, dan seluruh test tetap hijau
> karena test memakai pesan karangan sendiri. Ini persis kelas kesalahan yang
> harus dihindari: **salin pesan verbatim dari respons nyata, lalu tulis pola
> terhadap string itu**, bukan sebaliknya.

---

## 8. Testing

Test **colocated** di `packages/upstream-example/test/`. Pola harness yang sudah
dibuktikan (lihat `packages/upstream-ankr/test/ankr.test.ts`): injeksi
`BucketRegistry` + `fetchImpl` + `now()` statis → deterministik, tanpa mock
timer, tanpa jaringan.

```ts
import { describe, expect, test } from "bun:test"
import {
  BucketRegistry,
  silentLogger,
  type Group,
  type UpstreamInstanceConfig,
} from "upstream-core"
import { createAdapter } from "../src/index"

const cfg: UpstreamInstanceConfig = {
  name: "example-ethereum",
  provider: "example",
  package: "example",
  url_template: "https://rpc.example/{apikey}",
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
  expect(registry.peek("example", "KEY_A")!.credits(0)).toEqual([998]) // 1000 - 2
})
```

Skenario minimum yang wajib ada di package provider:

1. **Cost**: default package terpotong benar; `costs:` config instance
   mengalahkannya; lapisan global hanya mengisi metode yang tak dikenal.
2. **Signature**: error khas provider-mu → cap yang benar; error domain
   (`execution reverted` dsb.) → lolos tanpa match (null). Pakai **string
   respons verbatim**, bukan pesan karangan.
3. **Quirks** (bila ada): header benar terkirim; `countsBatchAsOne` berjalan.
4. **Translasi** (bila ada): `capability()` mengiklankan `kiseki_*` hanya ketika
   `methods:` mencakup metode upstream-nya; params invalid tidak memicu fetch;
   `mapResponse` memakai argumen `chain`; cost item kanonik memakai tarif metode
   upstream.

Jalankan per package: `bun test packages/upstream-example`. Seluruh monorepo:
`bun test` (hijau penuh adalah syarat PR — §10).

---

## 9. Menghubungkan ke Kiseki (Composition Root + Config)

### 9.1 Register di composition root

`packages/kiseki/src/registry.ts` adalah **satu-satunya** berkas di package
`kiseki` yang boleh meng-import provider package. Tambahkan import + satu
`register` — tidak ada perubahan lain di mana pun:

```ts
import { createAdapter as createExampleAdapter } from "upstream-example"

export const PACKAGE_EXAMPLE = "example"

export function buildRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(PACKAGE_GENERIC, createGenericAdapter)
  registry.register(PACKAGE_ALCHEMY, createAlchemyAdapter)
  registry.register(PACKAGE_ANKR, createAnkrAdapter)
  registry.register(PACKAGE_EXAMPLE, createExampleAdapter)   // ← satu baris baru
  return registry
}
```

Nama yang diregister = nilai yang sah untuk config `package:`. Nilai yang tidak
teregister → error startup (bukan silent fallback), dengan pesan yang menyebut
paket apa saja yang terdaftar.

### 9.2 Pakai di `kiseki.yaml`

```yaml
chains:
  ethereum:
    upstreams:
      - name: example-ethereum
        provider: example                # identitas sharing bucket
        package: example                 # ← adapter yang membangun instance ini
        url_template: "https://rpc.example/v1/{apikey}"
        apikeys:
          - token: "${EXAMPLE_KEY}"
            label: main
            buckets:
              - { capacity: 1000, refill_per_second: 10 }
        methods: ["eth_*"]               # kiseki_* OTOMATIS dari tabel translasi
        archive: false
```

Ingat semantik dua field identitas:

- `provider:` = kunci sharing bucket lintas chain — apikey sama di dua chain
  dengan `provider` sama = satu bucket bersama.
- `package:` = adapter mana yang membangun instance ini (§9.1).

> ⚠️ **Jangan menyatukan dua API berbeda di satu instance.** Satu instance hanya
> punya satu `url_template`, dan provider bisa melayani namespace berbeda di
> endpoint berbeda (Ankr: `ankr_*` hanya di `/multichain/`, `eth_*` hanya di
> `/eth/`, masing-masing `-32601` untuk method yang lain). Pakai **dua instance**
> dengan `provider` yang **berbeda**: provider adalah identitas bucket, dan bila
> jumlah bucket pada kedua instance berbeda, bucket dibangun ulang dan kredit
> yang sudah terpakai hilang tanpa peringatan.

### 9.3 Verifikasi akhir

```bash
bun install                      # daftarkan workspace baru
bun test                         # seluruh suite hijau
bun run --filter kiseki build    # binary tunggal tetap terbangun
```

Uji manual dengan config `kiseki.yaml` milikmu: metode yang provider baru bisa
melayani harus jalan; metode yang tidak → `-32601` pre-flight (config statis)
atau regroup ke upstream lain (runtime).

---

## 10. Checklist PR

- [ ] `src/index.ts` mengekspor `createAdapter: AdapterFactory` (satu file,
      tanpa logika routing)
- [ ] `package.json` mengikuti pola §3; hanya dep `upstream-core`
- [ ] Tidak ada file di luar package yang berubah **kecuali**
      `packages/kiseki/src/registry.ts` (dua baris) — bila lebih, jelaskan kenapa
- [ ] Tabel cost: sumber resmi dikutip + tanggal baca; angka 0 sah untuk metode
      gratis
- [ ] `matchCapability`: error domain → `null`; tidak ada pattern agresif yang
      bisa menelan domain error; kode error non-standar provider diperiksa
      eksplisit, bukan hanya lewat `isMethodNotFound`
- [ ] Setiap pattern error diuji dengan **string respons verbatim** dari provider,
      bukan pesan yang ditulis sendiri
- [ ] Test: cost + signature (+ quirks, + translasi bila ada) dengan harness
      injeksi §8; `bun test` hijau penuh
- [ ] Bila melayani `kiseki_*` (§5.1): `translations` diisi, `mapRequest` /
      `mapResponse` murni, validasi lewat `parseCanonicalParams`, `mapResponse`
      memakai argumen `chain` (bukan menebak dari payload), dan `methods:`
      memuat pola method upstream-nya (kalau tidak, canonical-nya tidak akan
      pernah diiklankan)
- [ ] Tidak ada entri `transport: "http"` sebelum engine-nya diimplementasi
- [ ] `mapResponse` diverifikasi terhadap respons provider **nyata** (fixture di
      test berasal dari panggilan sungguhan), bukan dari ingatan/dokumen saja
- [ ] Contoh config: satu instance = satu endpoint; jangan mencampur dua
      namespace provider yang dilayani endpoint berbeda (§9.2)
- [ ] Tidak ada token apikey yang di-log / ditulis / di-echo di manapun (§11)
- [ ] Contoh config di `kiseki.yaml` (atau docs) memakai `${VAR}`, bukan token
      mentah
- [ ] Kalau kebutuhanmu di luar kontrak `AdapterHooks`, itu **desain baru** →
      usulkan perubahan kontrak lebih dulu, bukan trik di package

---

## 11. Aturan yang Tidak Boleh Dilanggar

1. **Jangan pernah log token apikey** — hanya `label`. Logger di-inject; token
   tidak pernah masuk log/error/metric.
2. **Potong kuota terjadi sebelum fetch, tanpa refund** — sudah dijamin engine;
   implementasi manual pun wajib mempertahankannya.
3. **`ambiguous` (sendRaw) menghentikan total** — tidak boleh ada jalur retry di
   level package untuk hasil ambigu.
4. **Domain error passthrough** — jawaban node yang benar tidak boleh di-retry
   atau diubah.
5. **Dependensi satu arah** — provider package hanya boleh meng-import
   `upstream-core`; tidak boleh meng-import `kiseki` atau package provider lain.
6. **Config statis adalah sumber capability** — runtime matcher hanya koreksi;
   jangan pakai untuk "menebak" capability saat startup.
7. **Translasi kanonik tidak boleh menyentuh error provider** — `mapResponse`
   hanya untuk respons sukses; error tetap passthrough verbatim. Dan
   `mapRequest → undefined` berarti params client invalid, **bukan** capability
   mismatch: jangan pernah memaksakan regroup untuk kasus itu.
