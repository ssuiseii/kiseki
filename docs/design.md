# Desain Arsitektur — Blockchain RPC Proxy (codename: Kiseki)

> Status: **DESAIN FROZEN v1.3** — disepakati lewat diskusi terstruktur, 2026-11-21.
> v1.3 = revisi failover capability: **mismatch capability runtime → regroup & re-attempt ke upstream lain** (bukan error final); signature agresif (state hilang & block-not-found historis dihitung mismatch); nama main package `kiseki`.
> v1.2 = revisi auth: **path-key primer (gaya forge/cast/ethers) + allowlist multi-key berlabel; Bearer fallback**.
> v1.1 = revisi arsitektur: **monorepo + routing dua level (router → upstream package → pool apikey)**.
> Dokumen ini adalah acuan tunggal desain; rencana implementasi konkret ada di `docs/implementation.md`.
> Perubahan desain setelah titik ini harus lewat revisi dokumen, bukan keputusan diam-diam di kode.

---

## Daftar Isi

1. [Ringkasan & Tujuan](#1-ringkasan--tujuan)
2. [Keputusan Desain (frozen)](#2-keputusan-desain-frozen)
3. [Arsitektur Komponen & Monorepo](#3-arsitektur-komponen--monorepo)
4. [Alur Request End-to-End](#4-alur-request-end-to-end)
5. [Model Kuota: Kredit Terpadu](#5-model-kuota-kredit-terpadu)
6. [Router Level 1: Pemilihan Upstream](#6-router-level-1-pemilihan-upstream)
7. [Upstream Package: Pool Apikey & Failover Level 2](#7-upstream-package-pool-apikey--failover-level-2)
8. [Capability Matrix Statis](#8-capability-matrix-statis)
9. [Klasifikasi Request](#9-klasifikasi-request)
10. [Batch JSON-RPC: Split & Merge](#10-batch-json-rpc-split--merge)
11. [Kebijakan Error & Failover](#11-kebijakan-error--failover)
12. [Fail Fast & Estimasi Retry-After](#12-fail-fast--estimasi-retry-after)
13. [Health & Circuit Breaker (dua level)](#13-health--circuit-breaker-dua-level)
14. [Kebijakan Timeout](#14-kebijakan-timeout)
15. [Skema Config (YAML)](#15-skema-config-yaml)
16. [Auth](#16-auth)
17. [API Surface](#17-api-surface)
18. [Observability](#18-observability)
19. [State & Lifecycle](#19-state--lifecycle)
20. [Struktur Monorepo](#20-struktur-monorepo)
21. [Deployment](#21-deployment)
22. [Roadmap Fase 2](#22-roadmap-fase-2)
23. [Tradeoff & Risiko Terbuka](#23-tradeoff--risiko-terbuka)

---

## 1. Ringkasan & Tujuan

Proxy RPC blockchain yang **mengalokasikan request secara optimal** ke kumpulan upstream
(Alchemy, Ankr, dRPC, dan provider lain) dengan dua kendala utama:

1. **Limit laju per apikey upstream** — satuannya berbeda antar provider (RPS, RPM, CU/s),
   dimodelkan seragam sebagai *token bucket kredit terpadu*.
2. **Capability berbeda antar upstream** — tidak semua mendukung `trace_*`, `debug_*`,
   `replay_*`, atau state archive; proxy wajib hanya mengirim metode ke upstream yang
   benar-benar mendukungnya.

**Arsitektur inti (v1.1): routing dua level.**

- **Level 1 — main package `kiseki`**: klasifikasi, pre-flight capability,
  batch split & merge, dan pemilihan **upstream package** (provider) yang ready dan
  support metode yang dipanggil.
- **Level 2 — upstream package** (mis. `upstream-alchemy`): mengelola **pool apikey**
  milik provider itu. Satu provider bisa punya banyak apikey; ketika apikey A kena
  limit, package otomatis route ke apikey B yang tersedia. **Hanya setelah semua
  apikey gagal** package melaporkan error terstruktur ke router, dan barulah router
  mencoba upstream package lain.

**Non-goals (fase 1):**

- Bukan produk multi-tenant: tidak ada metering kuota per konsumen, tidak ada dashboard.
- Tidak menyediakan WebSocket / `eth_subscribe` (fase 2).
- Tidak melakukan cache atau dedupe request (fase 2).
- Bukan high-availability cluster: satu proses, state in-memory.

**Karakter yang dipilih secara sadar:**

- **Fail fast** — bukan antrian. Klien langsung menerima 429 + hint `Retry-After`.
- **Konservatif soal kuota** — lebih baik menolak lebih awal daripada melampaui limit provider.
- **Deterministik soal kebenaran** — "upstream mana yang BISA melayani metode X" hanya
  datang dari config statis + sinyal error runtime, tidak pernah dari tebakan.
- **Encapsulation** — router tidak pernah tahu detail internal provider (URL, apikey,
  cara parsing error-nya). Ia hanya melihat *capability, weight, dan outcome terstruktur*.

---

## 2. Keputusan Desain (frozen)

### 2.1 Keputusan v1.0 (semua tetap berlaku kecuali yang diamandemen di 2.2)

| # | Aspek | Keputusan |
|---|-------|-----------|
| 1 | Penggunaan | Self-use, 1–beberapa app milik sendiri |
| 2 | Auth | Bearer token statis di config |
| 3 | Multi-chain | Via path `/{chain}` |
| 5 | Model kuota | **Kredit terpadu**: bucket `{capacity, refill_per_second}` |
| 6 | Cost metode | Tabel dua lapis: default global + override per provider (Alchemy pakai CU asli) |
| 9 | Kuota habis | **Fail fast** → 429 + `-32005` + `Retry-After` terestimasi |
| 10 | Capability | **Config statis** per upstream (metode + archive) |
| 11 | Pre-flight | Cek capability sebelum kirim → error instan tanpa potongan kuota |
| 12 | Batch JSON-RPC | Split per kebutuhan capability → merge per index |
| 13 | `eth_sendRawTransaction` | 3 kelas hasil; ambigu **tidak pernah** di-retry |
| 14 | Potongan kuota | Per item batch, saat dikirim; tanpa refund |
| 15 | Health | Pasif (circuit breaker cooldown) |
| 16 | State | Semua in-memory; restart = bucket penuh |
| 17 | Timeout | Global 30s; kelas berat 120s; override per upstream |
| 18 | Stack | **TypeScript + Bun**, binary tunggal |
| 19 | Deploy | systemd unit + single binary |

### 2.2 Keputusan revisi v1.1 (routing dua level + monorepo)

| # | Aspek | Keputusan | Konsekuensi |
|---|-------|-----------|-------------|
| 20 | Struktur repo | **Monorepo**, Bun workspaces; main package `kiseki` (semula dinamai lain — diamandemen oleh #39) | Package terpisah per tanggung jawab; satu binary hasil build |
| 21 | Routing | **Dua level**: router pilih upstream package → package pilih apikey dari pool | Router buta detail provider; package otonom mengelola kuota apikey-nya |
| 22 | Pool apikey | Satu upstream package memakai **banyak apikey**; failover antar apikey terjadi **di dalam** package | Router baru diberi error setelah semua apikey gagal |
| 23 | Kontrak router↔upstream | **Outcome taxonomy terstruktur** (`success / rate_limited / unsupported / domain_error / sick / ambiguous`) | Router bereaksi terhadap kind, bukan parsing error mentah |
| 24 | Bucket lintas chain | Satu apikey (per provider) = **satu bucket bersama** di chain mana pun dia muncul | Sesuai cara provider menghitung kuota global per app key |
| 25 | Bobot level 1 | **Σ headroom semua apikey** di upstream itu (normalized per apikey) | Pool besar & longgar → bobot besar; proporsional kapasitas riil |
| 26 | Pilih apikey (level 2) | **Weighted-random proporsional sisa kredit** | Prinsip sama dengan level 1; menyebar otomatis |
| 27 | Granularitas package | **upstream-core generik** (pool engine + taxonomy) + **package tipis per provider** (URL, cost, parsing error) | Tanpa duplikasi logika pool; provider aneh tetap bisa diakomodasi |
| 28 | Tooling | **Bun workspaces** | Zero dependency tambahan untuk monorepo |
| 25a | Runtime capability-mismatch | **Bukan error final** → runtime note + regroup + re-attempt ke upstream lain (detail 2.5, #34) | Klien terlindungi dari config usang & kelewatan classifier; biaya: kuota attempt gagal hangus |

### 2.3 Amandemen atas keputusan v1.0

| # lama | Amandemen |
|---|-------|
| 2 | Auth bukan lagi satu Bearer token statis — diganti path-key primer + Bearer fallback dengan allowlist multi-key (detail 2.4) |
| 4 | "Upstream" bukan lagi satu URL+apikey, melainkan **instance provider per chain** yang membawa pool apikey (detail §7, §15) |
| 7 | Weighted-random router sekarang level 1, bobotnya dari sinyal agregat Σ headroom (bukan min-fraction bucket langsung) |
| 8 | "Coba semua kandidat" berlaku di **kedua level**: router mencoba semua upstream eligible; di dalamnya, pool mencoba semua apikey ready |
| 14 | Potongan kuota dieksekusi **oleh pool apikey terpilih**; router tidak pernah menyentuh bucket |
| 10 | Capability tetap config statis, tapi sinyal runtime (`-32601`/state hilang) kini **memengaruhi routing** — runtime note → exclude + re-attempt (#34–35), bukan lagi catatan pasif |
| 12 | Batch split kini **berulang**: regroup atas `unsupportedItems` outcome dan attempt lanjutan (§10.1 langkah 4–5) |

### 2.4 Keputusan tambahan v1.2 (auth)

| # | Aspek | Keputusan | Konsekuensi |
|---|-------|-----------|-------------|
| 29 | Jalur auth | **Path-key primer**: `POST /{chain}/{key}` (gaya forge/cast/ethers yang menaruh key di URL); **Bearer sebagai fallback** di `POST /{chain}` | Tool CLI & ethers key-in-URL langsung jalan tanpa header |
| 30 | Kunci klien | **Allowlist multi-key + label** di config | Trafik per app terlihat di metrics/log via label |
| 31 | Set kunci | Path-key & Bearer memvalidasi ke **satu set yang sama** | Satu sumber kebenaran; app bebas pindah metode |
| 32 | Query param | **Tidak** didukung (`?apikey=` ditolak) | Permukaan auth kecil — hanya dua jalur |
| 33 | `/metrics` | **Tanpa auth**, diamankan oleh bind localhost/private | Scrape paling sederhana; bind menjadi keputusan keamanan utama |

### 2.5 Keputusan tambahan v1.3 (failover capability & implementasi)

| # | Aspek | Keputusan | Konsekuensi |
|---|-------|-----------|-------------|
| 34 | Capability-mismatch runtime | **Re-attempt penuh**: item yang gagal karena mismatch di-regroup dan dicoba ke upstream eligible lain **dalam request yang sama**; `success`/`unsupported` membawa `unsupportedItems[]` | Amandemen #8, #10, #12, #13, #23. Klien terlindungi dari config usang & classifier yang kelewatan; kuota attempt gagal hangus (tanpa refund) |
| 35 | Signature mismatch | **Agresif**: `-32601` (method) + state hilang/pruned (archive) + **block/header not found pada query historis** (archive) | Blok yang memang tidak ada ikut di-retry sekali rute — diterima; error asli tetap diteruskan bila final |
| 36 | Error final capability | Setelah semua upstream dicoba → **error provider terakhir yang mengakhiri item** diteruskan apa adanya (passthrough) | Informatif untuk debugging; konsisten dengan prinsip passthrough |
| 37 | Resolusi `package:` | **Composition root** di main package: satu file meng-import semua provider package + mengisi registry; logika router tetap buta provider | Amandemen #20/#27: aturan dependensi §20 diperhalus |
| 38 | Validasi config | **zod** (shape) + validasi cross-field hand-rolled di atasnya | 1 dependency baru |
| 39 | Nama main package | **`kiseki`** (final) | Amandemen #20; binary bernama `kiseki` |
| 40 | Catatan implementasi | Kontrak kode konkret, algoritme, test plan → dokumen terpisah `docs/implementation.md` | design.md tetap konseptual |

---

## 3. Arsitektur Komponen & Monorepo

Satu proses Bun dari monorepo, komponen logis berikut:

```
                        ┌────────────────────────────────────────────────────────────┐
                        │                        kiseki (main)                  │
 ┌────────┐  HTTP/JSON  │  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐  │
 │ Client │────────────▶│  │ Ingress  │──▶│ Classifier + │──▶│ Batch Splitter     │  │
 │ (app   │  path-key / │  │ (Hono)   │   │ Pre-flight   │   │ (grup per caps)    │  │
 │ sendiri)│  Bearer     │  └──────────┘   │ capability   │   └─────────┬──────────┘  │
 └────────┘             │                 └──────────────┘             ▼             │
                        │                 ┌──────────────────────────────────────┐   │
                        │                 │ Router Level 1                       │   │
                        │   /metrics      │ eligible upstreams → weight =        │   │
                        │   /healthz      │ Σ headroom apikey → weighted-random  │   │
                        │                 └───┬──────────────┬──────────────┬────┘   │
                        └─────────────────────┼──────────────┼──────────────┼────────┘
                                              ▼              ▼              ▼
                          ┌────────────────────────┐ ┌───────────────┐ ┌────────────┐
                          │ upstream-alchemy       │ │ upstream-ankr │ │ upstream-… │
                          │ ┌────────────────────┐ │ │ (thin pkg di  │ │ (thin pkg) │
                          │ │ Apikey Pool (core) │ │ │  atas core)   │ │            │
                          │ │ [KEY_A][KEY_B][KEY_C]│ │ └──────┬────────┘ └─────┬──────┘
                          │ │ weighted-random,   │ │        │                │
                          │ │ cooldown per key,  │ │        │                │
                          │ │ deduct per item    │ │        │                │
                          │ └────────┬───────────┘ │        │                │
                          └──────────┼─────────────┘        │                │
                                     ▼                      ▼                ▼
                          ┌──────────────────────────────────────────────────────────┐
                          │           upstream-core: adapter interface + taxonomy    │
                          └──────────────────────────────────────────────────────────┘
                                     ▼
                          ┌────────────────────────────────────────────┐
                          │  RPC asli provider (Alchemy/Ankr/dRPC/dll) │
                          └────────────────────────────────────────────┘
```

| Komponen | Package | Tanggung jawab |
|----------|---------|----------------|
| **Ingress** | `kiseki` | HTTP server (Hono), auth (path-key primer + Bearer fallback), parsing body, response shaping |
| **Classifier + Pre-flight** | `kiseki` | Klasifikasi per item; agregasi capability; tolak instan metode mustahil |
| **Batch Splitter** | `kiseki` | Grup per kebutuhan capability; regroup loop (#34); merge per index |
| **Router Level 1** | `kiseki` | Pilih upstream package eligible (weighted-random atas Σ headroom); attempt loop antar upstream |
| **UpstreamAdapter + ApikeyPool** | `upstream-core` | Interface kontrak; engine pool apikey: weighted-random, bucket per identity, cooldown, deduct; taxonomy outcome |
| **Provider package** | `upstream-alchemy`, `upstream-ankr`, `upstream-drpc`, `upstream-generic` | Tipis: URL template, cost default provider, parsing signature error spesifik provider |
| **Upstream Client** | `upstream-core` | Fetch + timeout + reuse koneksi |

---

## 4. Alur Request End-to-End

### 4.1 Alur utama

```
Client → POST /{chain}
 │
 ├─ 1. Auth: path-key dari URL, else Bearer header (§16)
 │      → 401 jika tidak ada yang valid; label kunci dicatat untuk metrics
 ├─ 2. Parse body: single | batch | invalid → -32600
 ├─ 3. Per item: klasifikasi (prefix, archive?, idempotency)
 ├─ 4. PRE-FLIGHT capability (agregat semua upstream di chain):
 │      tak ada upstream yang support → error instan per item,
 │      tanpa potongan kuota, tanpa attempt
 ├─ 5. Batch dipecah jadi grup per kebutuhan capability
 │
 ├─ 6. LEVEL 1 — per grup (grup paralel), attempt loop upstream:
 │      a. eligible(u) = { capability ok ∧ weight(u)>0 ∧ ¬sick(u) ∧ ¬tried(u) }
 │      b. kosong → grup gagal fail-fast (§12) → lanjut grup lain
 │      c. pilih upstream: weighted-random atas weight = Σ headroom apikey
 │      d. panggil u.attempt(grup, ctx)
 │
 │   LEVEL 2 — di dalam upstream package (ApikeyPool):
 │      e. ready(k) = { semua bucket k ≥ cost ∧ ¬cooldown(k) ∧ ¬tried(k) }
 │      f. kosong → return outcome rate_limited(retryAt) ke router
 │      g. pilih apikey: weighted-random sisa kredit
 │      h. POTONG bucket apikey itu (sync, per item batch) → kirim
 │      i. sukses → return success(result)
 │      j. 429 dari provider → cooldown apikey itu → kembali ke (e)
 │      k. -32601 → runtime note + return unsupported
 │      l. 5xx/timeout → cooldown apikey singkat → kembali ke (e)
 │      m. sendRaw ambigu → return ambiguous (STOP total, lihat §11.3)
 │      n. semua apikey gagal → return rate_limited/sick ke router
 │
 └─ 7. Router bereaksi terhadap outcome kind (§11.1):
        success       → merge entries; bila membawa unsupportedItems →
                        runtime note + REGROUP item itu → kembali ke (6)
                        dengan upstream tadi di-exclude (§10.1 langkah 4)
        rate_limited  → tandai upstream, coba upstream berikutnya
        unsupported   → runtime note + REGROUP semua item → kembali ke (6)
        sick          → coba upstream berikutnya
        domain_error  → TERUSKAN apa adanya ke client, selesai
        ambiguous     → STOP TOTAL (tidak mencoba upstream lain)
        semua upstream gagal → item final: error provider terakhir yang
                        mengakhirinya diteruskan apa adanya (#36);
                        berakhir karena kapasitas/sick → fail fast (§12)
 │
 └─ 8. Merge hasil per index asli → response ke klien
```

### 4.2 Invariant yang dijaga alur ini

1. **Sebuah item hanya dikirim ke upstream yang config-nya menyatakan mendukung
   metode tersebut.** Sinyal runtime (`-32601`, state hilang) menandai config
   usang atau classifier kelewatan → runtime note + re-attempt ke upstream
   lain yang eligible (#34), bukan error final ke klien.
2. **Router tidak pernah menyentuh bucket.** Seluruh akuntansi kuota hidup di
   ApikeyPool milik package; potongan terjadi synchronous sebelum `fetch`.
3. **Tidak ada potongan tanpa kirim, tidak ada kirim tanpa potongan.**
4. **Urutan item batch terjaga** pada response — merge berdasarkan index asli.
5. **Satu batch boleh sukses parsial.**
6. **`eth_sendRawTransaction` tidak pernah dikirim dua kali**: failure ambigu
   menghentikan **kedua level** sekaligus (kontrak taxonomy, §11.3).
7. **Satu apikey = satu bucket, di mana pun dia muncul di config** (§5.4).
8. **Tiap upstream dicoba maksimal sekali per item** — loop regroup (#34)
   selalu mengecualikan upstream yang sudah mencoba item itu; loop dijamin
   terminasi.

---

## 5. Model Kuota: Kredit Terpadu

### 5.1 Masalah

Provider memakai satuan limit berbeda (Alchemy CU/s, Ankr RPS+RPM, dRVariasi).
Yang penting bukan angkanya, tapi mekanismenya: *jumlah kredit yang boleh dipakai
dalam window tertentu*.

### 5.2 Solusi: daftar bucket bebas, melekat pada apikey

```
ApiKey {
  provider  : string          // "alchemy" — bagian dari identitas
  token     : string          // secret; TIDAK PERNAH di-log
  label     : string          // label pendek untuk metric/log (mis. "a", "b")
  buckets   : Bucket[]        // satu bucket per dimensi limit
}

Bucket {
  capacity          : f64
  refill_per_second : f64
  credits           : f64     // mulai = capacity
}
```

- **Refill kontinu** (token bucket klasik): `credits = min(capacity, credits +
  elapsed × refill_per_second)`, dihitung **lazy** saat bucket dibaca/dipotong —
  tanpa timer, bebas drift, tanpa thundering herd di tepi window.
- RPS/RPM/CU/s masuk model yang sama: satu bucket per dimensi, semua dipotong
  bersamaan dengan cost yang sama.

### 5.3 Cost dua lapis

```
cost(method, upstream) = override_provider[method]
                      ?? default_global[prefix/method]
                      ?? 1
```

Default: 1 kredit = 1 request. Alchemy di-override dengan angka CU aslinya.

### 5.4 Identitas bucket & sharing lintas chain (keputusan #24)

Bucket **di-keying oleh `(provider, token)`** — bukan oleh instance chain:

```yaml
alchemy-ethereum:  apikeys: [KEY_A, KEY_B]
alchemy-base:      apikeys: [KEY_A, KEY_C]   # KEY_A → bucket yang SAMA
```

- Rasional: Alchemy (dan umumnya provider) menghitung throughput **per app key,
  global lintas network**. Model terpisah per chain akan under-count dan limit
  asli terjadi tanpa terdeteksi lokal.
- Implementasi: registry bucket di `upstream-core`, key = hash(provider+token).
  Instance chain mana pun yang mereferensikan token sama mendapat objek bucket
  yang sama (shared state, satu proses).
- Validation: kemunculan satu identity di >1 chain **bukan error** — itu perilaku
  yang dimaksud; hanya log info saat startup: `apikey a(shared): ethereum, base`.

### 5.5 Aturan potongan

1. **Dipotong oleh ApikeyPool, synchronous sebelum `fetch`** — atomik terhadap
   request lain (single-threaded event loop; tidak perlu mutex).
2. **Per item batch**, bukan per HTTP call (kecuali flag provider
   `counts_batch_as_one_request: true` → potong sekali per HTTP call).
3. **Diterapkan ke semua bucket apikey itu** dengan cost yang sama.
4. **Tanpa refund** untuk request gagal — konservatif, anti-overshoot.
5. **Eligibility apikey**: semua bucket `credits ≥ cost`.

### 5.6 Restart semantics

Semua bucket penuh saat restart — disengaja dan aman (limit provider ber-window
pendek; selama downtime provider sudah refill). Identity registry ikut hilang
dan dibangun ulang dari config; sharing tetap benar karena keying by identity.

---

## 6. Router Level 1: Pemilihan Upstream

### 6.1 Kandidat eligible

Untuk grup dengan kebutuhan `(methodSet, needsArchive)` di chain C:

```
eligible(u) =
    u.chain == C
  ∧ capability(u, methodSet)          // dari adapter, sumber: config statis (§8)
  ∧ (¬needsArchive ∨ u.archive)
  ∧ ¬runtimeNote(u, needSet)          // mismatch terbukti runtime (#34, §8.3)
  ∧ weight(u) > 0                     // ada apikey dengan headroom > 0
  ∧ ¬sick(u)                          // §13
  ∧ u ∉ tried(grup ini)
```

### 6.2 Bobot: Σ headroom semua apikey (keputusan #25)

Router tidak melihat bucket langsung. Tiap adapter melapor satu angka:

```
headroom_i(u) = min over buckets( credits_b / capacity_b )   // ∈ [0,1] per apikey i
weight(u)     = Σ_i headroom_i(u)                            // "jumlah apikey-bebas-ekuivalen"
```

Makna: apikey yang penuh menyumbang 0, apikey kosong menyumbang 1; pool 3 apikey
yang semuanya longgar berbobot ~3. Bobot proporsional terhadap **kapasitas riil**
(pool besar punya kesempatan lebih besar) dan **kelonggaran** (apikey yang hampir
habis menyusut kontribusinya).

Pemilihan: weighted-random standar (prefix kumulatif bobot).

**Sifat yang didapat:**

- Pool besar & longgar melayani porsi trafik lebih besar — proporsional kapasitas.
- Tanpa thundering herd; adaptif otomatis saat apikey habis/refill.
- Saat semua upstream sama-sama ketat, beban menyebar merata secara acak.

### 6.3 Attempt loop level 1

- Ulangi (pilih upstream → attempt → reaksi outcome) sampai `success`,
  `domain_error`, `ambiguous`, atau `eligible` kosong.
- **Batas attempt level 1 = jumlah upstream eligible** (keputusan #8 v1.0).
- `tried` di level upstream (bukan apikey) — package yang sama tidak dicoba
  dua kali untuk grup yang sama.
- Optional safety valve (default mati): `limits.max_total_attempts` per grup,
  memangkas worst-case latensi (§23).

---

## 7. Upstream Package: Pool Apikey & Failover Level 2

### 7.1 Kontrak adapter (upstream-core)

```ts
interface UpstreamAdapter {
  capability(): Capability            // methods: pattern[], archive: boolean
  weight(): number                    // Σ headroom semua apikey (§6.2)
  earliestReadyAt(): number           // estimasi waktu (ms epoch) apikey pertama
                                      // punya kredit cukup; untuk Retry-After (§12)
  attempt(group: Group, ctx: AttemptCtx): Promise<UpstreamOutcome>
}

type UnsupportedItem = {
  originalIndex: number
  method: string
  cap: "method" | "archive"     // jenis mismatch yang terbukti runtime
  providerError: JsonRpcError   // error asli provider; jadi error final bila
                                // tidak ada upstream lain tersisa (#36)
}

type Entry =
  | { originalIndex: number; ok: true;  result: JsonRpcResult }
  | { originalIndex: number; ok: false; error: JsonRpcError; final: boolean }

type UpstreamOutcome =
  | { kind: "success"; entries: Entry[]; unsupportedItems?: UnsupportedItem[] }
  | { kind: "domain_error"; entries: Entry[] }   // semua item = jawaban node final
  | { kind: "unsupported";  items: UnsupportedItem[] }   // semua item mismatch di upstream ini
  | { kind: "rate_limited"; retryAtMs: number }
  | { kind: "sick";         retryAtMs: number }
  | { kind: "ambiguous" }                        // STOP TOTAL (sendRaw)
```

Router **hanya** melihat tipe ini. URL, apikey, header, dan cara parsing error
provider adalah detail internal package.

### 7.2 ApikeyPool engine (hidup di upstream-core, dipakai semua provider)

- Pool = daftar `ApiKey` milik satu instance upstream (provider+chain).
- Pemilihan apikey: **weighted-random proporsional sisa kredit** — bobot per
  apikey = `min over buckets(credits/capacity)`, `ε` kecil menghindari bobot 0.
  (Keputusan #26; prinsip identik dengan level 1.)
- Attempt loop internal: coba apikey ready berikutnya sampai sukses / habis /
  stop-nonretry. Garanti terminasi via set `tried` per apikey.
- **Batch counting**: potongan per item batch, kecuali flag
  `counts_batch_as_one_request` → sekali per HTTP call.
- Result classification di level pool: memakai **signature parser dari provider
  package** (tipis) untuk memetakan HTTP status/body → outcome kind.

### 7.3 Provider package (tipis)

Tanggung jawab yang tersisa di tiap provider:

| Tanggung jawab | Contoh |
|---|---|
| Bangun URL dari template + token | `https://eth-mainnet.g.alchemy.com/v2/{apikey}` |
| Cost default provider | tabel CU Alchemy |
| Signature error spesifik provider | bentuk body 429 Alchemy vs Ankr vs dRPC |
| Kuirk khusus provider | header wajib, query param, dsb. |

Provider tanpa keunikan berarti bisa memakai **`upstream-generic`** + config
(regex error, URL template) — tanpa package baru.

---

## 8. Capability Matrix Statis

### 8.1 Sumber kebenaran

Config statis per instance upstream (keputusan #10). Dua dimensi: `methods`
(daftar pola prefix, `*` trailing only) dan `archive` (boolean).

### 8.2 Pre-flight

Sebelum grup dikirim: agregasi capability **semua upstream instance di chain
itu** (dari masing-masing adapter). Tidak ada yang mencakup kebutuhan grup →

```
error instan per item: code -32601
"method not supported by any configured upstream"
→ tanpa potongan kuota, tanpa attempt
```

### 8.3 Sinyal runtime & re-attempt (keputusan #34–36)

Sinyal runtime kini **bukan error final** — ia menandai mismatch capability
yang terbukti, dicatat sebagai note, dan itemnya di-regroup untuk dicoba ke
upstream eligible lain dalam request yang sama (§10.1 langkah 4–5).

| Sinyal dari provider | cap | Arti | Aksi |
|---|---|---|---|
| `-32601` (method not found / not available) | `method` | config bilang support, faktanya tidak | runtime note(instance, method) + item masuk `unsupportedItems` |
| "state missing / pruned / not available" untuk block historis (`missing trie node`, `state pruned`, dsb.) | `archive` | upstream ternyata non-archive | runtime note(instance, archive) + `unsupportedItems` |
| "block / header not found" pada query **historis** (block lama/hash, bukan `"latest"`) | `archive` | kemungkinan classifier kelewatan ATAU blok memang tak ada | `unsupportedItems` (signature agresif #35) — bila semua upstream habis, error asli diteruskan (#36) |

- Signature matching memakai **parser provider package** (tipis) + fallback
  pattern umum di `upstream-core` (§implementation.md).
- Runtime note in-memory per instance, key-independent; memengaruhi `eligible`
  (§6.1) sehingga request **berikutnya** tidak mengulangi kesalahan yang sama.
- `-32601` yang muncul **setelah** item lolos pre-flight dan hanya tersisa di
  satu upstream → item final: error provider diteruskan apa adanya (#36).

---

## 9. Klasifikasi Request

Per item JSON-RPC (tidak berubah dari v1.0):

```ts
type Classified = {
  method: string
  methodClass: MethodClass      // menentukan cost default & timeout
  needsArchive: boolean
  idempotency: "READ" | "NON_IDEMPOTENT"
  cost: number
}
```

### 9.1 Deteksi kebutuhan archive

- Block tag `"earliest"` atau hex number `< tip − 128` → archive.
- Block hash → asumsi archive (konservatif, fase 1).
- `"latest"` / `"pending"` → tidak memicu.

### 9.2 Kelas idempotency

| Kelas | Metode | Kebijakan |
|---|---|---|
| `READ` | semua kecuali sendRaw | bebas failover dua level |
| `NON_IDEMPOTENT` | `eth_sendRawTransaction` | 3-kelas hasil (§11.3), ambigu = stop total |

`eth_sendTransaction` & sejenisnya masuk `blocked_methods` default.

---

## 10. Batch JSON-RPC: Split & Merge

### 10.1 Algoritme

1. Kunci grup per item: `(frozenset(upstream-instance-yang-bisa-melayani),
   needsArchive, idempotencyClass)`.
2. Pre-flight per item: set kosong → `-32601` instan, dikeluarkan dari pengiriman.
3. Grup tersisa dikirim **paralel**; tiap grup menjalankan attempt loop level 1
   sendiri — tiap grup bisa berakhir di upstream berbeda.
4. **Regroup loop (#34)**: outcome membawa `unsupportedItems` → catat runtime
   note per instance → item-item itu dikeluarkan dari grup lama, dihitung ulang
   eligible-nya (upstream yang sudah mencoba item itu + yang kena note
   di-exclude), digrup ulang, dan diattempt lagi. Ulangi sampai tidak ada
   `unsupportedItems` baru atau kandidat habis.
5. **Finalisasi (#36)**: item yang tak punya kandidat lagi → final dengan
   **error provider terakhir** yang mengakhirinya (passthrough); item yang
   berakhir karena semua upstream rate-limited/sick → ikut fail fast (§12).
6. Merge response per index asli.

### 10.2 Contoh

Upstream A (alchemy-ethereum: `eth_*`,`trace_*`, archive, pool 3 key),
upstream B (ankr: `eth_*`, non-archive, pool 1 key). Batch 5 item:

```
[0] eth_blockNumber         → set {A, B}   grup G1
[1] trace_block             → set {A}      grup G2
[2] eth_call (block lama)   → set {A}      grup G2
[3] trace_transaction       → set {A}      grup G2
[4] eth_getBalance (latest) → set {A, B}   grup G1
```

- G1 dikirim ke A atau B (weighted-random antar upstream).
- G2 hanya bisa ke A. Di dalam A: kalau KEY_A kena 429 → pool otomatis pindah
  ke KEY_B/KEY_C — **router tidak tahu kejadian itu** (transparan).
- Baru kalau A menghabiskan ketiga key-nya → `rate_limited` naik ke router →
  router tandai A dan (karena G2 tak punya upstream lain) G2 gagal fail-fast;
  G1 tetap bisa sukses ke B.

### 10.3 Edge cases

- Batch 1 item = alur single. Batch besar: diterima apa adanya + log warning.
- Item invalid dalam batch: `-32600` di index itu saja, lainnya jalan.

---

## 11. Kebijakan Error & Failover

### 11.1 Matrix outcome → aksi router (level 1)

| Outcome dari package | Aksi router | Lanjut upstream lain? |
|---|---|---|
| `success(entries)` tanpa `unsupportedItems` | merge entries; update skor latensi | — |
| `success(entries, unsupportedItems)` | merge entries sukses; runtime note per item mismatch; **regroup** item mismatch → attempt lanjutan (#34) | ya (untuk item mismatch) |
| `unsupported(items)` | runtime note; **regroup** semua item | ya |
| `rate_limited(retryAtMs)` | simpan retryAt untuk estimasi; tandai upstream | ya |
| `sick(retryAtMs)` | simpan retryAt | ya |
| `domain_error` | **teruskan apa adanya ke client** (jawaban node yang benar: `execution reverted`, `nonce too low`, dll. — sama di upstream mana pun) | **tidak** |
| `ambiguous` | **STOP TOTAL** untuk item ini | **tidak, dan tidak boleh** |
| kandidat habis untuk item | item final: **error provider terakhir** yang mengakhirinya diteruskan (#36); kapasitas/sick → fail fast §12 | — |

### 11.2 Matrix kejadian → aksi pool (level 2, di dalam package)

| Hasil provider | Klasifikasi pool | Aksi |
|---|---|---|
| 2xx result | sukses | update latensi; return `success` |
| HTTP 429 | apikey kena limit | `credits=0` semua bucket key itu + cooldown (Retry-After header bila ada, else estimasi refill) → coba apikey lain; semua key kena → `rate_limited(retryAt = min retryAt antar key)` |
| `-32601` | capability mismatch (`cap: method`) | runtime note instance; item → `unsupportedItems`; **campuran** (ada item sukses/domain) → `success` + `unsupportedItems`; **semua item mismatch** → `unsupported` |
| state pruned / missing trie node (query historis) | capability mismatch (`cap: archive`) | perlakuan sama dengan `-32601` |
| block/header not found (query **historis** saja) | capability mismatch (`cap: archive`, agresif #35) | perlakuan sama; bila final → error asli diteruskan (#36) |
| Error domain client/node | jawaban benar | return `domain_error` apa adanya — **tanpa** mencoba apikey lain |
| 5xx / timeout / koneksi gagal | key/provider sakit | cooldown eksponensial singkat pada key itu → coba key lain; gagal beruntun lintas key (default 3) → provider-level sick cooldown → `sick` |
| Body invalid | provider tidak sehat | sama dengan 5xx |

### 11.3 `eth_sendRawTransaction` — 3 kelas hasil (kontrak lintas level)

| Kelas | Gejala | Aksi pool | Aksi router |
|---|---|---|---|
| **Definitif ditolak** | JSON-RPC error node (`nonce too low`, `insufficient funds`, `already known`, dll.) | `domain_error` | teruskan; tidak ada failover |
| **Gagal jelas pra-broadcast** | DNS/refused/TLS — request tak pernah sampai node | coba **apikey lain** dalam pool | `success`/`rate_limited` sesuai akhir pool |
| **Ambigu** | timeout / reset / 5xx — tak diketahui apakah tx sampai | **hentikan pool**, return `ambiguous` | **STOP TOTAL** — tidak mencoba upstream lain; error `-32007` "broadcast state unknown" ke client |

Rasional: bukan takut duplikasi broadcast (raw tx sama = hash sama = idempotent
di jaringan), tapi **kejelasan semantik**: client tidak boleh menerima "sukses
dari upstream kedua" untuk tx yang mungkin sudah diterima upstream pertama.
Kontraknya tegas: `ambiguous` berhenti di level mana pun ia muncul.

---

## 12. Fail Fast & Estimasi Retry-After

### 12.1 Kapan fail fast

`eligible` kosong di level 1 (semua upstream: cooldown/kuota/sudah dicoba) →
selesai untuk grup itu, tanpa menunggu.

### 12.2 Rumus estimasi (dua level)

- Di dalam pool: tiap apikey kurang kredit punya `t_ready(k) = max((cost −
  credits)/refill, sisa_cooldown)`; pool melapor `earliestReadyAt() = min_k
  t_ready(k)` — tersedia untuk router bahkan sebelum outcome terjadi.
- Router: `Retry-After = clamp( min over capable upstreams(max(earliestReadyAt(u),
  sisa_sick(u))) , floor=0.5s, ceiling=30s )`.

Klien menerima hint realistis; retry layer sisi client tidak perlu backoff buta.

### 12.3 Shaping respons fail-fast

| Kasus | HTTP | Body |
|---|---|---|
| Single, tak ada kandidat berkuota | `429` + `Retry-After` | error `-32005` |
| Batch, semua item gagal kapasitas | `429` + `Retry-After` | array `-32005` per index |
| Batch, sukses parsial | `200` | array campuran result/error |
| Capability miss (pre-flight) | `200` | `-32601` per item terkait |

---

## 13. Health & Circuit Breaker (dua level)

Tanpa probe aktif. Kesehatan diukur dari trafik nyata, di **kedua level**:

| Level | Kejadian | Efek |
|---|---|---|
| Pool (per apikey) | sukses | reset gagal-beruntun |
| Pool (per apikey) | 429 | bucket 0 + cooldown sampai refill (bukan eksponensial — itu limit, bukan sakit) |
| Pool (per apikey) | 5xx/timeout/koneksi | cooldown eksponensial `1s → 2s → … cap 60s` |
| Pool (provider) | gagal beruntun **lintas apikey berbeda** (default 3) | provider-level sick cooldown eksponensial — hindari menghammer key lain ke outage yang sama |
| Pool | `-32601` / domain error | **tidak** memengaruhi health |
| Router (per upstream) | `sick` / `rate_limited` outcome | upstream tidak eligible selama retryAt; otomatis kembali setelahnya |

---

## 14. Kebijakan Timeout

| Metode | Timeout efektif |
|---|---|
| Default | `30s` |
| Kelas berat: `trace_*`, `debug_*`, `replay_*` | `120s` |
| Override per instance upstream | menang |

Timeout per attempt (per apikey yang dicoba), via `AbortSignal.timeout()`.
Total waktu klien dibatasi alami oleh (jumlah upstream × apikey per upstream ×
timeout) — tradeoff terdokumentasi §23; safety valve opsional §6.3.

---

## 15. Skema Config (YAML)

```yaml
# kiseki.yaml — contoh lengkap, nilai ilustratif
server:
  port: 8545
  host: "127.0.0.1"
  auth:
    methods: ["path", "bearer"]            # path primer, bearer fallback
    keys:                                  # kunci KLIEN (bukan apikey upstream)
      - { token: "${KISEKI_KEY_MAIN}",    label: main }
      - { token: "${KISEKI_KEY_INDEXER}", label: indexer }

defaults:
  costs:
    "eth_call": 1
    "eth_getLogs": 2
    "trace_*": 5
    "debug_*": 5
    "replay_*": 10
  timeouts:
    default_seconds: 30
    heavy_seconds: 120
    heavy_methods: ["trace_*", "debug_*", "replay_*"]
  blocked_methods: ["eth_sendTransaction"]

chains:
  ethereum:
    upstreams:
      - name: alchemy-ethereum           # instance = provider + chain
        provider: alchemy                # identitas sharing bucket (§5.4)
        package: alchemy                 # package adapter; "generic" = fallback
        url_template: "https://eth-mainnet.g.alchemy.com/v2/{apikey}"
        apikeys:
          - { token: "${ALCHEMY_KEY_A}", label: a,
              buckets: [{ capacity: 330, refill_per_second: 330 }] }
          - { token: "${ALCHEMY_KEY_B}", label: b,
              buckets: [{ capacity: 330, refill_per_second: 330 }] }
        methods: ["eth_*", "trace_*", "debug_*", "replay_*"]
        archive: true
        costs: { "eth_call": 2, "trace_block": 5 }   # CU asli (override)
        counts_batch_as_one_request: false

      - name: ankr-ethereum
        provider: ankr
        package: generic                 # tanpa package khusus
        url_template: "https://rpc.ankr.com/eth/{apikey}"
        apikeys:
          - { token: "${ANKR_KEY}", label: main,
              buckets:
                - { capacity: 15,  refill_per_second: 15 }    # RPS
                - { capacity: 600, refill_per_second: 10 } }  # RPM
        methods: ["eth_*"]
        archive: false

  base:
    upstreams:
      - name: alchemy-base
        provider: alchemy
        package: alchemy
        url_template: "https://base-mainnet.g.alchemy.com/v2/{apikey}"
        apikeys:
          # KEY_A sama dengan di ethereum → bucket SHARED otomatis (§5.4)
          - { token: "${ALCHEMY_KEY_A}", label: a,
              buckets: [{ capacity: 330, refill_per_second: 330 }] }
        methods: ["eth_*", "debug_*"]
        archive: true

limits:
  max_total_attempts: 0        # 0 = tak terbatas (default); >0 = safety valve

metrics:
  enabled: true
```

### 15.1 Aturan validasi config (fail-fast saat startup)

1. `chains` tidak kosong; tiap chain minimal 1 upstream.
2. `capacity > 0`, `refill_per_second > 0` (refill 0 dilarang).
3. `name` instance unik global; `label` apikey unik dalam instance-nya.
4. `${VAR}` yang tidak ada di environment → error startup.
5. Kontradiksi `blocked_methods` ∩ `methods` upstream → error startup.
6. Peringatan bila chain tanpa upstream archive.
7. `url_template` wajib memuat placeholder `{apikey}`.
8. Info (bukan error) saat satu identity `(provider, token)` muncul di >1 chain:
   `apikey a(alchemy): shared bucket → ethereum, base`.
9. `auth.keys` tidak boleh kosong; `token` tiap klien unik, `label` unik.
10. `chain` tidak boleh memakai reserved names: `metrics`, `healthz` (benturan
    dengan route tetap).

---

## 16. Auth

### 16.1 Dua jalur autentikasi

| Jalur | Bentuk | Dipakai siapa |
|---|---|---|
| **Path-key (primer)** | `POST /{chain}/{key}` | forge, cast, ethers & tool apa pun yang menaruh key di URL (gaya Alchemy/Infura) |
| **Bearer (fallback)** | `POST /{chain}` + header `Authorization: Bearer <token>` | app server yang bisa mengelola header |

```
http://kiseki-host:8545/ethereum/KISEKI_KEY_MAIN   ← forge --rpc-url langsung jalan
```

- Kedua jalur memvalidasi ke **satu allowlist yang sama** (keputusan #31) —
  app bisa pindah jalur tanpa ganti kunci.
- Kedua jalur valid sekaligus (key di path **dan** Bearer header) → cukup
  salah satu cocok untuk lolos.
- Query param (`?apikey=`) **ditolak** (keputusan #32).

### 16.2 Allowlist kunci klien

```yaml
auth:
  keys:
    - { token: "${KISEKI_KEY_MAIN}",    label: main }
    - { token: "${KISEKI_KEY_INDEXER}", label: indexer }
```

- Kunci ini adalah **kunci klien → router** — sepenuhnya terpisah dari apikey
  upstream (provider).
- `label` tampil di metrics & log (`client_label`) sehingga trafik per app
  terlihat; token **tidak pernah** di-log.
- Kunci tidak dikenal / tidak ada → `401` + JSON-RPC error `-32000`
  "unauthorized". Tidak ada rate limit per kunci (self-use).

### 16.3 Semantik route & ordering

1. Route tetap dicek duluan: `GET /healthz` (terbuka), `GET /metrics` (tanpa
   auth, keputusan #33 — diamankan oleh bind localhost/private network).
2. Baru `POST /{chain}[/{key}]`:
   - chain tidak dikenal → `404` + `-32602` **setelah** auth lolos; auth gagal
     → `401` apa pun chain-nya (auth dulu, baru chain).
3. Toleransi bentuk: trailing slash diabaikan (`/ethereum/KEY/` = valid);
   path-key kosong (`/ethereum/`) → diperlakukan sebagai request tanpa key
   (jalur Bearer yang menentukan).

### 16.4 Keamanan

- Path-key muncul di URL → mudah bocor ke access log pihak ketiga. Maka:
  proxy **tidak pernah** menulis key mentah di log/response/error — hanya
  label; dan bind default `127.0.0.1`. Jika di depan ada reverse proxy, access
  log-nya akan berisi key — pertimbangkan bind langsung (tanpa proxy) untuk
  jalur ini, atau proxy tanpa logging path.
- Bearer tetap didukung penuh untuk app yang ingin menghindari key di URL.

---

## 17. API Surface

| Route | Method | Fungsi |
|---|---|---|
| `/{chain}/{key}` | POST | JSON-RPC utama, auth via path-key (primer) |
| `/{chain}` | POST | JSON-RPC utama, auth via Bearer (fallback) |
| `/metrics` | GET | Prometheus (tanpa auth — bind localhost/private) |
| `/healthz` | GET | Liveness systemd (tanpa auth) |

### 17.1 Error code proxy

| Code | Arti |
|---|---|
| `-32000` | unauthorized / kesalahan umum proxy |
| `-32005` | semua upstream berkuota habis / rate-limited |
| `-32006` | tidak ada upstream sehat (semua sick) |
| `-32007` | broadcast state unknown (sendRaw ambigu) |
| `-32601` | metode tidak didukung upstream mana pun (pre-flight) |
| `-32600` | body bukan JSON-RPC valid |
| `-32602` | chain tidak dikenal |

---

## 18. Observability

### 18.1 Metrics Prometheus

| Metric | Tipe | Label |
|---|---|---|
| `kiseki_requests_total` | counter | chain, method_class, client_label |
| `kiseki_batch_items_total` | counter | chain, client_label |
| `kiseki_upstream_attempts_total` | counter | upstream(instance), outcome |
| `kiseki_pool_key_attempts_total` | counter | upstream, apikey(label), outcome |
| `kiseki_pool_key_failover_total` | counter | upstream |
| `kiseki_apikey_credits` | gauge | provider, apikey(label), bucket_index |
| `kiseki_apikey_cooldown_seconds_remaining` | gauge | provider, apikey(label) |
| `kiseki_upstream_latency_seconds` | histogram | upstream |
| `kiseki_preflight_rejects_total` | counter | chain, reason |
| `kiseki_capability_regroups_total` | counter | chain, cap(`method`\|`archive`) |
| `kiseki_failfast_total` | counter | chain, method_class |
| `kiseki_sendraw_ambiguous_total` | counter | upstream |

Catatan: label apikey memakai **label** bukan token. Ada dua dimensi attempt:
`upstream_attempts` (level 1, terlihat router) dan `pool_key_attempts` (level 2,
transparansi internal pool).

### 18.2 Logging

JSON ke stdout. Level `warn`: capability mismatch, apikey 429, provider sick,
fail fast. **Jangan log params request** (bisa sensitif), **jangan pernah log
token apikey upstream** maupun **key klien** — hanya `label` upstream apikey dan
`client_label`. Full-body debug via `KISEKI_DEBUG_BODIES=1`.

---

## 19. State & Lifecycle

| State | Lokasi | Hidup restart | Hidup reload (SIGHUP) |
|---|---|---|---|
| Config terparse | memori, dari YAML | ya — di-reload | ya |
| Registry bucket (keyed `(provider, token)`) | memori | **tidak** (penuh lagi) | **ya** — identity sama → bucket sama, credits dipertahankan |
| Cooldown per apikey & per provider | memori | tidak | ya (identity-keyed) |
| Runtime note capability (per instance) | memori | tidak | direset |
| Metrics | memori | tidak | ya |

**Reload config**: re-parse YAML; bucket tidak di-reset selama proses hidup
karena di-keying identity — menambah apikey baru tidak mengganggu apikey lama;
apikey yang dihapus dari config → bucket-nya dibuang.

---

## 20. Struktur Monorepo

Bun workspaces (`"workspaces": ["packages/*"]`).

```
kiseki/
├── package.json              # root: workspaces, scripts (dev/test/build)
├── tsconfig.base.json
├── docs/
│   ├── design.md             # dokumen ini (konseptual)
│   └── implementation.md     # rencana implementasi konkret (v1.3)
├── kiseki.yaml               # config contoh/deploy
├── kiseki.service            # systemd unit
├── packages/
│   ├── kiseki/               # MAIN: binary hasil build
│   │   └── src/
│   │       ├── index.ts      # entry: args/env, load config, start server
│   │       ├── registry.ts   # COMPOSITION ROOT: import semua provider package
│   │       │                 #   + isi AdapterRegistry (keputusan #37)
│   │       ├── config/       # schema zod (#38) + load + env interpolation + SIGHUP
│   │       ├── classify/     # klasifikasi per item (§9)
│   │       ├── capability/   # agregasi + pre-flight (§8)
│   │       ├── batch/        # split, regroup loop (#34), merge (§10)
│   │       ├── router/       # level 1: weighted-random Σ headroom + loop (§6)
│   │       ├── server/       # Hono: routes, auth, response shaping
│   │       └── observ/       # metrics + logger
│   ├── upstream-core/        # kontrak & engine bersama
│   │   └── src/
│   │       ├── types/        # jsonrpc.ts, outcome.ts (taxonomy), group.ts
│   │       ├── adapter.ts    # interface UpstreamAdapter + AdapterFactory
│   │       ├── registry.ts   # AdapterRegistry (diisi composition root)
│   │       ├── pool.ts       # ApikeyPool: weighted-random, loop, cooldown
│   │       ├── bucket.ts     # token bucket lazy refill (identity-keyed registry)
│   │       ├── http.ts       # fetch client + timeout + reuse koneksi
│   │       ├── result.ts     # klasifikasi hasil → outcome kind
│   │       └── capsig.ts     # signature mismatch umum (-32601, state pruned, …)
│   ├── upstream-alchemy/     # tipis: URL, cost CU, parser error Alchemy
│   ├── upstream-ankr/        # tipis (bila perlu; else pakai generic)
│   ├── upstream-drpc/        # tipis (bila perlu; else pakai generic)
│   └── upstream-generic/     # fallback: config-driven (url template + regex error)
└── (test colocated: packages/<pkg>/test/*.test.ts — bukan folder test/ root)
```

Aturan dependensi antar package (satu arah, dengan satu pengecualian #37):

```
kiseki/src/registry.ts → upstream-core + semua provider package   (composition root)
kiseki (logika lain)   → upstream-core SAJA (buta provider)
upstream-alchemy / ankr / drpc / generic → upstream-core
```

Logika router/server/classifier **tidak** meng-import package provider; hanya
`registry.ts` yang boleh, dan dia tidak berisi logika — hanya memetakan nilai
config `package:` → factory adapter (§implementation.md).

Testing per package jalan mandiri (`bun test packages/upstream-core`) — manfaat
langsung dari pemisahan ini.

---

## 21. Deployment

```bash
bun install
bun test
bun run --filter kiseki build               # → bun build --compile src/index.ts
```

Binary tunggal dari package `kiseki`, tanpa runtime dependency di host.

`kiseki.service` (sketch, sama dengan v1.0):

```ini
[Unit]
Description=Kiseki RPC Proxy
After=network-online.target
Wants=network-online.target

[Service]
User=kiseki
ExecStart=/opt/kiseki/kiseki --config /etc/kiseki/kiseki.yaml
EnvironmentFile=/etc/kiseki/env
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

---

## 22. Roadmap Fase 2

1. **Deteksi archive otomatis** — signature error "state missing" per provider;
   upstream terbukti non-archive → runtime note permanen (persist ringan).
2. **Cache & dedupe** — `eth_call` ke block finalized identik di-merge; cache
   TTL pendek untuk read-only. Hemat kuota besar untuk trafik indexer.
3. **Capability probe berkala** — untuk upstream jarang dipakai sebelum
   dipercaya melayani `trace_*` yang mahal.
4. **WebSocket / `eth_subscribe`** — koneksi stateful dipin ke satu apikey +
   upstream; re-subscribe otomatis saat disconnect.
5. **Kuota per konsumen** — bila dipakai lebih dari satu app.
6. **Persist kuota** — snapshot registry bucket ke disk (identity-keyed), bila
   restart sering dan over-kirim awal terbukti masalah.
7. **Admin API kecil** — lihat bucket/cooldown per apikey real-time.

---

## 23. Tradeoff & Risiko Terbuka

| # | Tradeoff / Risiko | Penjelasan | Mitigasi |
|---|---|---|---|
| 1 | **Worst-case latensi kian membengkak** — attempt = Σ upstream × Σ apikey | Konsekuensi "coba semua kandidat" dua level | Sick cooldown memangkas kandidat; safety valve `max_total_attempts`; 429 & domain error terdeteksi cepat |
| 2 | **Estimasi kuota bukan kebenaran provider** | Limit tersembunyi (concurrent, burst, per-IP) tak termodel | Sinyal 429 nyata selalu menang; cooldown & bucket=0 saat kena |
| 3 | **Per-IP limit di free tier** | Banyak apikey di satu IP tetap kena limit agregat | Sadari saat mengisi config; sesuaikan bucket ke limit agregat bila itu yang kena duluan |
| 4 | **Restart = over-kirim awal** | §5.6 | Diterima; persist ada di roadmap |
| 5 | **Shared bucket bergantung kebenaran accounting provider** | Kalau provider ternyata menghitung per-network, sharing bikin over-conservatif | Dampaknya hanya kehilangan sedikit utilisasi (bukan kegagalan); flag per-provider bisa ditambah bila terbukti |
| 6 | **Router buta detail internal pool** | Debugging buta per-key butuh observability | `pool_key_*` metrics + label apikey + log per outcome (§18) |
| 7 | **Randomness di routing dua level** | Distribusi non-deterministik | Log upstream+apikey terpilih per attempt; seed RNG opsional untuk replay |
| 8 | **Cost table perlu dirawat** | Angka CU provider berubah | Default 1 aman; override hanya di tempat penting |
| 9 | **Tidak ada HA** | Satu proses = SPOF | systemd restart; klien bisa menunjuk dua proxy |
| 10 | **Registry adapter + monorepo = sedikit complexity majemuk** | Satu lapis indirection `package:` → adapter | Dibayar balik oleh testability per package & isolasi provider; composition root tunggal (#37) menjaga logika router tetap buta provider |
| 11 | **Re-attempt capability = kuota ganda untuk item mismatch** | Item yang gagal mismatch dipotong di upstream pertama, lalu dipotong lagi di upstream kedua (#34) | Diterima demi koreksi otomatis config usang; pre-flight & runtime note menekan frekuensi kejadian |
| 12 | **Signature agresif block-not-found bisa me-retry blok yang memang tidak ada** | Query blok nonexistent di-retry sekali rute ke upstream archive (#35) | Biaya bounded: maksimal Σ upstream attempt; error asli diteruskan di akhir (#36) |

---

## Lampiran A: Keputusan kecil oleh perancang (defaults, bisa dibantah)

- Framework HTTP: **Hono**; port default **8545**; host default `127.0.0.1`.
- Auth default `methods: ["path", "bearer"]`; minimal satu entri di `auth.keys`.
- Config default `./kiseki.yaml`, override via `--config` / `KISEKI_CONFIG`.
- Nama main package: **`kiseki`** (final — keputusan #39); binary bernama `kiseki`.
- Provider tanpa keunikan → `upstream-generic`, tanpa package baru.
- Sick threshold lintas-key default **3 gagal beruntun**; eksponensial 1s→cap 60s.
- `limits.max_total_attempts` default **0 (tak terbatas)** — konsisten dengan
  keputusan #8; valve hanya dipasang bila worst-case latensi terbukti masalah.
- JSON-RPC 2.0 saja; `eth_sendTransaction` di `blocked_methods` default.

## Lampiran B: Yang masih perlu diisi manusia sebelum coding

1. **Angka limit riil per apikey** tiap provider/tier → mengisi `buckets` & `costs`.
2. Daftar chain yang benar-benar dipakai + apikey mana dipakai lintas chain
   (untuk memanfaatkan shared bucket dengan benar).
3. **Daftar kunci klien** (`auth.keys`) — token + label per app yang memakai proxy.
4. Konfirmasi per provider: accounting per-key global vs per-network (menyangkut
   §5.4), dan batch dihitung per item vs per HTTP call.
5. Bebas tidaknya bind `0.0.0.0` bila client tidak satu mesin dengan proxy.
