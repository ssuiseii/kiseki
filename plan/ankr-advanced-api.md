# Rencana B — Package `upstream-ankr` (Ankr Advanced API)

> **Status:** siap dieksekusi di sesi baru. Self-contained — tidak perlu
> konteks percakapan perencanaan.
> **Prasyarat:** [Rencana A](namespace-kanonik-core.md) sudah merge (kontrak
> `MethodTranslation` + skema kanonik ada di `upstream-core`).
> Ditulis: 2026-11-21. Dokumen Ankr dibaca 2026-11-21.

---

## 0. Konteks Proyek (untuk sesi baru)

- **Repo:** `/home/horikita/Kiseki` — monorepo Bun/TypeScript, proxy RPC
  blockchain dengan routing dua level. Runtime Bun ≥ 1.1.
- **Perintah:** `bun install` · `bun run check` · `bun run build`.
- **Package:** `kiseki` (server+router), `upstream-core` (engine),
  `upstream-generic` (fallback), `upstream-alchemy` (thin provider,
  ❌ **TIDAK BOLEH DISentuh di rencana ini** — keputusan user 2026-11-21).
- **Guide wajib dibaca dulu:** `docs/upstream-package-guide.md` — tutorial
  lengkap membuat provider package; contoh fiktifnya justru `upstream-ankr`,
  termasuk scaffold `package.json`/`tsconfig.json`, pola test harness, dan
  checklist PR (§3, §8, §10 guide).
- **Latar namespace `kiseki_*`:** provider punya method non-standar berbeda
  (`ankr_*`, `alchemy_*`, …) yang kadang hanya aktif di plan tertentu.
  Kiseki menyediakan namespace kanonik: client call `kiseki_*`, package
  provider menyuplai tabel translasi `MethodTranslation` (kontrak ada di
  `upstream-core/src/namespace.ts` hasil Rencana A), dan coverage `kiseki_*`
  di `capability()` dihasilkan otomatis dari tabel itu. Router kiseki tidak
  berubah. Method mentah provider (`ankr_*`) tetap bisa dipakai langsung.

## 0.1 Keputusan Frozen (hasil diskusi dengan pemilik proyek)

| # | Keputusan |
|---|---|
| F1 | Respons `kiseki_*` = **skema kanonik kiseki** (normalisasi dua arah; skema di core, Rencana A) |
| F2 | `upstream-alchemy` **tidak diubah sama sekali**; semua metode kanonik v1 dilayani Ankr |
| F3 | Client tetap boleh call method mentah (`ankr_*`, `eth_*`) langsung — namespace kanonik hanya lapisan alias |
| F4 | Ankr memakai **URL per-chain** (`https://rpc.ankr.com/eth/{apikey}`) — AAPI diasumsikan dilayani di sana; **diverifikasi M0**, kalau ternyata hanya multichain → revisi keputusan dengan user |
| F5 | Prefix kanonik = `kiseki_` |
| F6 | Perubahan `upstream-core` sudah ditangani Rencana A — plan ini murni package Ankr + registrasi |

## 0.2 Revisi setelah M0 (disetujui user 2026-11-22)

| # | Revisi | Alasan |
|---|---|---|
| R1 | **F4 diganti**: Ankr butuh **dua instance per chain** — `ankr-<chain>-aapi` (multichain, `methods: ["ankr_*"]`) + `ankr-<chain>-node` (per-chain, `methods: ["eth_*"]`). | AAPI tidak dilayani endpoint per-chain, dan endpoint multichain menolak semua method node. Satu instance = satu `url_template` (`plan/notes-m0.md` §1). |
| R2 | **F6 dilonggarkan satu kali**: `MethodTranslation.mapResponse` menerima argumen ketiga `chain`. | Semua skema kanonik mewajibkan `chain` di result, tetapi payload provider sering tidak memuatnya (halaman kosong tidak memuat apa pun). Perubahan aditif: 1 baris tipe + 3 baris di `pool.ts`; implementasi lama tetap sah. |
| R3 | Instance AAPI memakai `provider: ankr-aapi`, node memakai `provider: ankr-node` (bukan `ankr` keduanya). | `provider` = identitas bucket. Dua set bucket dengan satuan berbeda di satu identitas → `BucketRegistry.get` membangun ulang bucket saat jumlah bucket berubah, dan kredit terpakai hilang tanpa peringatan. |

---

## 1. Ringkasan

Package `upstream-ankr` baru — thin provider package sesuai guide — dengan
keunikan Ankr:

1. **Tabel cost API Credits**: Advanced API = 700 credits/request (§4).
2. **Capsig khas Ankr** (plan-gate → `"method"` → regroup runtime).
3. **Alias chain** Ankr (`ethereum` → `eth`, …) untuk param `blockchain`.
4. **Tabel translasi** `kiseki_*` → `ankr_*` untuk 6 metode (§3).

`eth_call` & method standar sama seperti provider lain — tanpa perlakuan
khusus.

## 2. Fakta Ankr (sumber: docs resmi, dibaca 2026-11-21)

- Dokumen: <https://www.ankr.com/docs/advanced-api/overview/> (halaman
  `.md` bisa diakses dengan menambah `.md` di URL; versi Markdown
  LLM-friendly tersedia).
- **17 metode Advanced API** (semua prefix `ankr_`):
  - *NFT*: `ankr_getNFTsByOwner`, `ankr_getNFTMetadata`, `ankr_getNFTHolders`,
    `ankr_getNftTransfers`
  - *Query*: `ankr_getBlockchainStats`, `ankr_getBlocks`, `ankr_getLogs`,
    `ankr_getTransactionsByHash`, `ankr_getTransactionsByAddress`,
    `ankr_getInteractions`
  - *Token*: `ankr_getAccountBalance`, `ankr_getCurrencies`,
    `ankr_getTokenPrice`, `ankr_getTokenHolders`, `ankr_getTokenHoldersCount`,
    `ankr_getTokenTransfers`, `ankr_getTokenPriceHistory`
- **Cost PAYG AAPI seragam: 700 API Credits/request** (0.10 USD = 1M
  credits) — semua 17 method AAPI. Method node standar (`eth_*`) tidak
  disebut berbayar khusus → default 1.
- **Param `blockchain` memakai alias Ankr** (BUKAN nama chain kiseki):
  mainnet `arbitrum`, `avalanche`, `base`, `bsc`, `eth` (=ethereum!), `fantom`,
  `flare`, `gnosis`, `linea`, `optimism`, `polygon`, `scroll`,
  `somnia_mainnet`, `taiko`, `telos`, `xlayer`; testnet `avalanche_fuji`,
  `base_sepolia`, `eth_sepolia`, `optimism_sepolia`, `polygon_amoy`.
- **Detail param/respon per metode** (tipe, paging, bentuk result) HARUS
  dibaca saat M0 dari halaman per metode:
  `/docs/advanced-api/token-methods/`, `/docs/advanced-api/query-methods/`,
  `/docs/advanced-api/nft-methods/` (tambahkan `.md` untuk versi Markdown).
  **Jangan menulis translasi dari ingatan** — verifikasi bentuk param asli
  dulu, catat hasilnya di `plan/notes-m0.md`.
- Stellar dilayani namespace `stellar_*` terpisah — di luar scope.

## 3. Tabel Translasi (6 metode kanonik)

| Kanonik | Ankr asli | Catatan pemetaan |
|---|---|---|
| `kiseki_getTokenTransfers` | `ankr_getTokenTransfers` | filter `contract`, range block, paging → `nextPage` opaque |
| `kiseki_getTransactionsByAddress` | `ankr_getTransactionsByAddress` | order & paging dinormalisasi |
| `kiseki_getAccountBalance` | `ankr_getAccountBalance` | multichain param Ankr dibatasi chain instance (F4); native + ERC-20 |
| `kiseki_getNFTsByOwner` | `ankr_getNFTsByOwner` | owner + contract filter; metadata mentah dibuang di v1 |
| `kiseki_getNFTMetadata` | `ankr_getNFTMetadata` | kanonik: chain, contract, tokenId, name?, image?, collection? |
| `kiseki_getTokenPrice` | `ankr_getTokenPrice` | `{ chain, contract, priceUsd, updatedAt }` |

Prinsip skema kanonik (skema Zod-nya ada di core, Rencana A §3): nilai
token = string desimal + `valueRaw` hex; `nextPage` opaque; nama chain =
nama kiseki (`ethereum`, bukan `eth`); field strict.

Metode AAPI lain (daftar §2) **tetap terpakai via nama mentah `ankr_*`**
(F3) — cost 700 tetap terdeduct lewat pola cost table (§4). Di-alias-kan ke
kanonik nanti kalau provider lain menyusul — bukan di plan ini.

## 4. Cost: API Credits

```ts
/** Sumber: docs/advanced-api/overview PAYG table, dibaca 2026-11-21. */
export const ANKR_COSTS: CostTable = {
  "ankr_get*": 700,   // seluruh Advanced API, seragam
  // eth_* & node API standar: tidak diisi → jatuh ke lapisan global/1
}
```

- Pola `"ankr_get*"` (bukan `"ankr_*"`) sengaja: method Ankr non-`get`
  yang mungkin muncul boleh jatuh ke lapisan global, tidak dikunci 700.
- Lapisan resolusi core: `cfg.costs → hooks.costs → defaults.costs → 1`.
  **Angka = milik package; mekanisme deduct/bucket = core** — pembagian
  tidak berubah dari kode sekarang.
- Lookup cost item kanonik otomatis pakai **nama upstream** (dijamin
  Rencana A §4 poin 4) — entri 700 terkena untuk `kiseki_get*` juga.
- **Peringatan deployment** (wajib masuk docs & komentar config): bucket
  RPS kecil (mis. 15) bisa dihabisi ~47× lebih cepat oleh satu panggilan
  AAPI dibanding `eth_call`. Operator mungkin perlu bucket kredit terpisah.

## 5. Isi `src/index.ts` (satu file, pola guide §4)

1. **`ANKR_COSTS`** (§4).
2. **`matchAnkrCapability: CapabilityErrorMatcher`**:
   - `-32601`/method-not-found → `"method"` (eksplisit; redundan vs
     fallback generik core tapi dokumentatif);
   - pesan plan-gate → `"method"` → regroup runtime;
   - **sisanya `null`** — `execution reverted` dll. WAJIB lolos tanpa match
     (passthrough final #36); salah match = regroup percuma + kuota hangus.
   - **Pola pesan plan-gate diambil dari error nyata M0** — contoh guide
     (`/method not allowed for your (plan|tier)|upgrade your plan/`)
     adalah ILLUSTRATIVE, wajib diverifikasi sebelum dipakai.
3. **`ANKR_CHAIN_ALIASES`** — Record nama-chain-kiseki → alias Ankr (dari
   daftar §2; minimal yang dipakai deployment: `ethereum → eth`, `base`,
   `bsc`, `polygon`, `arbitrum`, `optimism`, `avalanche`, `gnosis`, dst.).
   Chain tanpa entri → `mapRequest` return `undefined` (invalid params),
   BUKAN ditebak.
4. **`ANKR_TRANSLATIONS`** — `readonly MethodTranslation[]` untuk 6 metode
   §3. `mapRequest(params, chain)`: validasi lewat skema Zod core, susun
   param Ankr (alias `blockchain`, paging, filter); `mapResponse(result,
   params)`: normalisasi ke skema kanonik. **Murni pemetaan bentuk** —
   tanpa I/O, tanpa cache.
5. `createAdapter: AdapterFactory` = `createPoolAdapter(cfg, deps, {
   costs: ANKR_COSTS, matchCapability: matchAnkrCapability, translations:
   ANKR_TRANSLATIONS })` — sesuai kontrak `AdapterHooks` hasil Rencana A.

Yang **tidak** ditulis di package (sudah di engine): pemilihan apikey,
deduct kuota, cooldown, klasifikasi HTTP 429/5xx/timeout, URL `{apikey}`,
timeout, perhitungan coverage `kiseki_*` di capability.

## 6. Perubahan per Package

| Package | Perubahan |
|---|---|
| `upstream-core` | ❌ sudah lewat Rencana A — tidak disentuh lagi |
| `upstream-ankr` | **Baru**: `package.json` + `tsconfig.json` (pola guide §3), `src/index.ts`, `test/ankr.test.ts` |
| `upstream-alchemy` | ❌ **tidak disentuh sama sekali** (F2) |
| `kiseki` | Hanya `src/registry.ts`: +import, +`registry.register(PACKAGE_ANKR, createAnkrAdapter)` (2 baris; guide §9.1). Nilai register = `package:` yang sah di config |
| `kiseki.yaml` | Instance `ankr-ethereum`: `package: generic` → `package: ankr`; `methods: ["eth_*", "ankr_*"]`; komentar contoh `kiseki_*` |
| docs | `upstream-package-guide.md`: bagian "Menambah metode kanonik kiseki_*" (sisi konsumen tabel translasi); README: cara pakai namespace + peringatan skala cost AAPI |

Checklist PR guide berlaku penuh: satu file src, hanya dep `upstream-core`,
tak ada file di luar package yang berubah kecuali `registry.ts` (2 baris),
tak ada token di log/manapun, cost table mengutip sumber + tanggal.

## 7. Contoh Config (kiseki.yaml)

```yaml
chains:
  ethereum:
    upstreams:
      - name: ankr-ethereum
        provider: ankr                 # identitas sharing bucket lintas chain
        package: ankr                  # ← berubah dari "generic"
        url_template: "https://rpc.ankr.com/eth/{apikey}"
        apikeys:
          - token: "${ANKR_KEY}"
            label: main
            buckets:
              - { capacity: 15,  refill_per_second: 15 }   # RPS
              - { capacity: 600, refill_per_second: 10 }   # RPM
        methods: ["eth_*", "ankr_*"]   # ankr_* untuk passthrough mentah (F3);
                                       # coverage kiseki_* OTOMATIS dari tabel
                                       # translasi package — tidak perlu ditulis
        archive: false
```

## 8. Milestone

- [x] **M0 — Verifikasi lapangan (tanpa kode produktif):** SELESAI
      (hasil: `plan/notes-m0.md`).
  - [x] Probe endpoint: AAPI **hanya** di `/multichain/`; `/eth/` menolak
        semua `ankr_*`. **F4 terbukti salah** → direvisi bersama user menjadi
        **dua instance per chain** (lihat §0.2).
  - [x] Rekam error nyata: `-32601`, `-32075` "Method disabled", `-32602`
        invalid params, `-32090` rate limit, `-32000`/`-32052` auth. Plan-gate
        khusus (upgrade plan) **tidak** teramati → tidak ada regex karangan.
  - [x] Baca detail param/respon per metode + rekam bentuk respons nyata.
- [x] **M2 — Package:** SELESAI
  - [x] Scaffold (pola guide §3), `bun install` dari root.
  - [x] `ANKR_COSTS` + `matchAnkrCapability` + `ANKR_CHAIN_ALIASES` +
        `ANKR_TRANSLATIONS` (§5). Catatan: `ANKR_CHAIN_ALIASES` memakai kunci
        kiseki ber-tanda-hubung (`arbitrum-one`, `base-sepolia`) karena
        `CHAIN_NAME` kanonik melarang `_`/spasi.
  - [x] Test §9 (46 test); register di `kiseki/src/registry.ts`; `bun run check`.
- [x] **M4 — Config & docs:** SELESAI — `kiseki.yaml` (dua instance Ankr),
      guide §2/§5.1/§9.2/§10, README.
- [x] **M5 — Integration test:** SELESAI — `packages/kiseki/test/ankr-integration.test.ts`
      (9 test, lewat pipeline asli). `bun run build` sukses.

## 9. Test Plan (`packages/upstream-ankr/test/ankr.test.ts`)

Harness injeksi tanpa jaringan — pola `upstream-alchemy/test/alchemy.test.ts`
(`BucketRegistry` + `fetchImpl` + `now()` statis; contoh harness ada di
guide §8):

1. **Cost**: `kiseki_getTokenTransfers` → 700 terdeduct; `ankr_*` mentah →
   700; `eth_call` → 1; override `costs:` config instance menang.
2. **Capability**: adapter dengan translasi → `capability()` mencover
   `kiseki_*`; tanpa translations → tidak (pre-flight `-32601`).
3. **Translasi request**: param kanonik → param Ankr benar, termasuk
   `blockchain: "eth"` untuk chain `ethereum`; paging → cursor Ankr.
4. **Translasi respons**: fixture result Ankr → kanonik (desimalisasi,
   `nextPage`, nama chain kiseki); field tak dikenal dibuang.
5. **Invalid params kanonik** → domain error "invalid params"; tanpa
   regroup; tanpa fetch.
6. **Capsig**: plan-gate (pola M0) → `"method"`; method-not-found →
   `"method"`; `execution reverted` → `null` (passthrough final).
7. **Alias chain**: chain tanpa entri alias → invalid params, bukan tebakan.
8. **Batch campuran**: `eth_*` + `kiseki_*` + `ankr_*` satu request →
   translasi tepat per item, urutan `originalIndex` terjaga.

## 10. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| AAPI tidak dilayani endpoint per-chain | M0 sebelum M2; kalau gagal → revisi F4 bersama user |
| Skala cost 700 menghabisi bucket RPS kecil | Docs §4 + komentar config; escape hatch `costs:` per instance |
| Pesan error Ankr berubah / pola capsig keliru | M0 wajib rekam error nyata; matcher konservatif — tidak yakin = `null` (fallback generik), jangan agresif |
| Availability AAPI berubah per plan | Capsig plan-gate → `"method"` → regroup runtime; coverage per package, core tak berubah |
| Translasi salah bentuk param (dibuat dari ingatan) | M0 mewajibkan baca doc per metode + rekam bentuk di notes; test pakai fixture dari doc |
| Drift kontrak `MethodTranslation` | Rencana A sudah merge dulu (prasyarat); B hanya konsumen |

Poin terbuka (putuskan saat M2): apakah alias chain perlu override per
instance di config (`chain_aliases:`) atau konstanta package cukup.
