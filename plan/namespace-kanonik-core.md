# Rencana A — Kontrak Namespace Kanonik `kiseki_*` di `upstream-core`

> **Status:** siap dieksekusi di sesi baru. Dokumen ini self-contained: sesi
> implementasi TIDAK perlu konteks percakapan perencanaan.
> **Urutan eksekusi:** Rencana A dulu, merge; baru Rencana B
> (`plan/ankr-advanced-api.md`).
> Ditulis: 2026-11-21.

---

## 0. Konteks Proyek (untuk sesi baru)

- **Repo:** `/home/horikita/Kiseki` — monorepo Bun/TypeScript, proxy RPC
  blockchain dengan routing dua level (router level-1 pilih provider;
  ApikeyPool per provider pilih apikey). Runtime: Bun ≥ 1.1.
- **Perintah:** `bun install` · `bun run check` (typecheck + semua test) ·
  `bun run build` (binary `packages/kiseki/dist/kiseki`).
- **Package:**
  - `packages/kiseki/` — HTTP server, auth, router, batch pipeline.
  - `packages/upstream-core/` — engine: kontrak adapter, ApikeyPool, bucket.
  - `packages/upstream-generic/` — fallback config-driven (tidak diubah).
  - `packages/upstream-alchemy/` — thin provider CU table (❌ **TIDAK BOLEH
    DISentuh di rencana ini** — keputusan user 2026-11-21).
- **Dokumen desain:** `docs/design.md`, `docs/implementation.md`,
  `docs/upstream-package-guide.md` (guide contributor; referensi pola test).

**Masalah yang diselesaikan:** provider punya namespace method non-standar
yang berbeda-beda (`ankr_*`, `alchemy_*`, …) dan kadang hanya aktif di plan
tertentu. Client harusnya cukup hafal satu namespace netral — `kiseki_*` —
dan kiseki yang menerjemahkan + meroute ke upstream yang support.

**Mekanisme:** tabel translasi hidup di **package provider** (Rencana B
menyuplai tabel Ankr); `upstream-core` menyediakan kontraknya dan
menjalankan translasi di dalam pool. Router/pre-flight/regroup kiseki **tidak
diubah sama sekali** — `kiseki_*` terlihat sebagai method biasa yang
kebetulan dicover upstream tertentu.

**Aturan dependensi (design.md #37, wajib):** `upstream-core` tidak boleh
import package provider atau `kiseki`; hanya `kiseki/src/registry.ts` yang
boleh import provider package. Rencana ini tidak menyentuh keduanya.

---

## 1. Cakupan Perubahan

| Package | Perubahan |
|---|---|
| `upstream-core` | **Ya** — file baru `src/namespace.ts`; ubah `src/pool.ts`; rapikan `src/adapter.ts`; export dari `src/index.ts`; test `test/namespace.test.ts` + tambahan `test/pool.test.ts` |
| `upstream-generic` | Tidak |
| `upstream-alchemy` | **Tidak** (F6) |
| `kiseki` | Tidak |

---

## 2. Kode yang Ada Sekarang (fakta, sudah diverifikasi baca langsung)

Detail penting supaya tidak perlu menebak:

1. **`upstream-core/src/pool.ts:476`** — `export type AdapterHooks = {
   matchCapability?, costs?, headers?, countsBatchAsOne?, observer?,
   random? }`. Inilah hooks yang benar-benar dipakai `createPoolAdapter`.
2. **`upstream-core/src/adapter.ts:92`** — ada `export type ProviderHooks`
   dengan nama BEDA (`matchCapabilityError`, `defaultTimeoutMs`) yang tidak
   dipakai pool. Ini **dead type** → hapus atau samakan dengan `AdapterHooks`
   (rapikan di M1a; pilih: hapus `ProviderHooks` dari `adapter.ts`, ekspor
   `AdapterHooks` dari `pool.ts` via `src/index.ts`).
3. **`upstream-core/src/pool.ts:529-536`** — `createPoolAdapter` membangun
   `UpstreamAdapter`; **`capability: () => ({ methods: cfg.methods,
   archive: cfg.archive })`** di baris 532 adalah titik enrich capability.
4. **`upstream-core/src/pool.ts:157-174`** — `itemCost(method)` /
   `chargeFor(group)` resolve cost per **nama method item**. Ini titik
   translasi cost.
5. **`upstream-core/src/pool.ts:190-223`** — loop `attempt`: deduct sync
   SEBELUM fetch, tanpa refund (§5.5); `ambiguous` sendRaw stop total —
   **jangan ubah semantik ini**.
6. **`upstream-core/src/cost.ts`** — lapisan cost:
   `cfg.costs → hooks.costs → deps.globalCosts → 1`
   (`buildLayeredCostResolver`, `pool.ts:501`). Angka cost = milik package;
   mekanisme = milik core. **Pembagian ini tidak berubah.**
7. **`upstream-core/src/methods.ts`** — pola capability: exact atau trailing
   `*` saja (`matchesMethodPattern`).
8. **`upstream-core/src/types/group.ts`** — `Group`/`GroupItem`:
   `GroupItem = { originalIndex, id, method, params, historical }`.
   `Entry` (hasil per item) ada di `types/outcome.ts`.
9. **Test harness:** pola `packages/upstream-alchemy/test/alchemy.test.ts` —
   injeksi `BucketRegistry`, `fetchImpl` palsu, `now()` statis; tanpa
   jaringan & tanpa mock timer. Ikuti persis.

---

## 3. Kontrak Baru: `src/namespace.ts` (file baru)

```ts
/**
 * Canonical-namespace contract (kiseki_*).
 *
 * A provider package declares HOW it serves a canonical method; the pool
 * engine applies the mapping transparently. The router never sees any of
 * this: capability enrichment makes the canonical name look like any other
 * covered method.
 */

export type MethodTranslation = {
  /** Canonical method served, e.g. "kiseki_getTokenTransfers". */
  canonical: string
  /** Real upstream method, e.g. "ankr_getTokenTransfers". */
  upstream: string
  /**
   * Canonical params → upstream params. `undefined` = invalid canonical
   * params (client error) → domain error entry, NOT a capability mismatch.
   */
  mapRequest(params: readonly unknown[], chain: string): unknown[] | undefined
  /** Upstream result → canonical result. Success responses only. */
  mapResponse(result: unknown, params: readonly unknown[]): unknown
  /**
   * Upstream transport. Default "jsonrpc" (rewrite method/params, send via
   * the normal JSON-RPC body). "http" is reserved for providers whose
   * enhanced APIs are REST (e.g. Alchemy NFT v3, Prices API) — contract only
   * in this plan; implementation deferred.
   */
  transport?: "jsonrpc" | "http"
}

export type NamespaceHooks = {
  /** Empty/absent = package serves no canonical methods. */
  translations?: readonly MethodTranslation[]
}
```

**Skema kanonik Zod** untuk param & result tiap metode `kiseki_*` juga hidup
di file ini — satu sumber kebenaran, dipakai semua package provider (aturan
dependensi tetap terjaga). Set metode & bentuk datanya: lihat Rencana B §5.
Kaidah skema:

- **Strict**: field tak dikenal → invalid params (zod `.strict()`).
- Alamat `0x…`, hash, quantity hex → regex eksplisit.
- Nilai token: string desimal utuh + `valueRaw` hex apa adanya (jangan pakai
  number JS untuk nilai Wei).
- Paging: field `nextPage` opaque string | null; client mengembalikannya
  apa adanya di request berikutnya.
- Nama chain di respons = nama chain kiseki (`ethereum`, bukan `eth`).

## 4. Perubahan `src/pool.ts` — Empat Titik

Semua di dalam engine; tidak ada perubahan di router/server/kiseki.

1. **Enrich capability** (titik: `pool.ts:532`). Saat `createPoolAdapter`
   punya `hooks.translations`, `capability().methods` = `cfg.methods` +
   setiap `canonical` yang `upstream`-nya dicover pola `cfg.methods`
   (pakai `matchesMethodPattern`). Hindari duplikat. Upstream **tanpa**
   translasi tidak berubah → `kiseki_*` tak dicover → pre-flight `-32601`
   seperti perilaku lama.
2. **Translate per attempt** (titik: awal `attempt`/`tryKey`, sebelum body
   JSON-RPC dibangun). Tiap `GroupItem` yang method-nya cocok suatu
   translation (lookup `canonical` exact) dikirim upstream sebagai
   `(upstream, mapRequest(params, chain))`. `group.chain` tersedia di
   `Group`. `mapRequest → undefined` → **Entry domain error** "invalid
   params" untuk item itu (bukan mismatch, TIDAK regroup, tanpa fetch).
3. **mapResponse sukses** (titik: tempat `Entry` sukses dibentuk).
   `mapResponse(result, paramsAsli)` sebelum `Entry.result`. **Error
   provider TIDAK diterjemahkan** — passthrough verbatim (keputusan #36).
   Jika `mapResponse` throw → bug package: log error (tanpa token) dan
   perlakukan sebagai domain error, jangan retry upstream lain.
4. **Cost lookup pakai nama upstream** (titik: `itemCost`, `pool.ts:157`).
   Item kanonik di-resolve cost-nya dengan nama upstream hasil translasi
   (`ankr_getTokenTransfers` → entri 700 terkena), bukan nama kanonik.
   Implementasi saran: `itemCost` menerima nama efektif item (hasil
   translasi) — bukan mengubah tabel cost. Terapkan juga pada
   `chargeFor`/`eligibilityCost` (keduanya memanggil `itemCost`).

Tipe `AdapterHooks` (`pool.ts:476`) ditambah field `translations?: readonly
MethodTranslation[]`. Semantik lain pool tidak berubah.

## 5. Coverage Kanonik = per (provider × plan)

Namespace unik provider bisa hanya aktif di plan tertentu dan bisa berubah.
Kaidah:

- Capability statis ditulis sesuai plan apikey yang dikonfigurasi (operator
  tahu plan-nya); runtime plan-gate → matcher package return `"method"` →
  regroup ke upstream lain yang cover method kanonik sama (#34, sudah ada).
- Coverage diturunkan dari tabel translasi package — bukan hardcoded global.
  Plan lebih rendah = kurangi entri translasi di package itu; core tak berubah.
- Kontrak `mapResponse`: murni pemetaan bentuk — tanpa I/O, tanpa cache.

## 6. Milestone

- [x] **M1a** — `src/namespace.ts` (tipe + skema Zod kanonik; set metode
      sesuai Rencana B §5); rapikan drift tipe di `adapter.ts` (hapus
      `ProviderHooks` dead type, ekspor `AdapterHooks`); export dari
      `src/index.ts`.
- [x] **M1b** — empat titik §4 di `pool.ts`; test §7; `bun run check`
      hijau penuh **tanpa** menyentuh package lain.

**Catatan implementasi (2026-11-21):**

- Translasi dijalankan sekali per `attempt()` (bukan per key): cost, charge,
  dan body semuanya butuh nama upstream, jadi menghitungnya sekali lebih murah
  dan menghindari `mapRequest` dipanggil berulang pada jalur failover.
- `classifyBody` menerima item yang benar-benar dikirim (client view), supaya
  item kanonik yang sudah dijawab lokal tidak dianggap "missing envelope".
- `poolOutcome` menghitung ulang `resultCount`/`errorCount` **setelah**
  `mapResponse`, sehingga kegagalan mapping ikut menentukan `domain_error`.
- `transport: "http"` tidak diiklankan di `capability()` dan, kalau tetap
  dipanggil, dijawab lokal sebagai domain error final (tidak pernah POST
  JSON-RPC ke endpoint REST).
- Skema chain menolak alias provider (`eth`, `bsc`, …) supaya alias tidak bocor
  ke payload kanonik.

## 7. Test Plan (`upstream-core/test/`)

Harness injeksi (pola alchemy.test.ts) — tanpa jaringan:

1. **Capability enrichment**: fake package dengan 1 translation + config
   `methods: ["eth_*", "ankr_*"]` → `capability()` mencover canonical;
   tanpa translations → tidak mencover.
2. **Translasi request**: canonical request → body upstream berisi
   `(upstream, params hasil mapRequest)`; alias chain benar.
3. **Invalid params**: `mapRequest → undefined` → Entry domain error untuk
   item itu; item lain dalam batch tetap diproses; TIDAK ada regroup.
4. **mapResponse**: result upstream → bentuk kanonik di `Entry.result`;
   error upstream lolos apa adanya.
5. **Cost nama upstream**: item canonical men deduct cost entri upstream
   (700, bukan 1); `eth_call` tetap 1; override `cfg.costs` menang.
6. **Batch campuran**: `eth_*` + canonical + raw `ankr_*` satu request →
   urutan `originalIndex` terjaga.
7. **Regroup tetap bekerja**: matcher package `"method"` → item regroup ke
   upstream lain (pakai dua adapter fake) — memastikan enrich capability
   tidak merusak jalur #34.
8. **Semantik pool tak berubah**: deduct-sebelum-fetch; `ambiguous`
   stop total (uji regresi lama tetap hijau).

## 8. Aturan yang Tidak Boleh Dilanggar

1. Jangan pernah log token apikey — hanya label.
2. Deduct sebelum fetch, tanpa refund; `ambiguous` sendRaw stop total.
3. Domain error passthrough verbatim — tidak boleh di-retry/diubah.
4. Dependensi satu arah: core tidak import provider package / kiseki.
5. Router, pre-flight, grouping, server: **nol perubahan**. Kalau tampak
   butuh perubahan di sana → desain salah, berhenti dan revisi.
6. Test tanpa jaringan (fetch/clock/random diinjeksi).
