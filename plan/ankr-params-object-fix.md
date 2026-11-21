# Rencana C — Follow-up: params objek Ankr + clamp pageSize (perbaikan implementasi `upstream-ankr`)

> **Status:** ✅ SELESAI DIIMPLEMENTASI 2026-11-22 (lihat §8). Folder `packages/upstream-ankr/`
> yang ada sekarang sudah berfungsi (606 test hijau) tetapi mengirim bentuk `params`
> yang **tidak sesuai kontrak docs Ankr**. Rencana ini memperbaikinya di dua titik:
> satu perubahan kecil di core (kontrak), satu perubahan di package.
>
> **Prasyarat:** tidak ada. Semua perubahan bersifat self-contained. Sesuai instruksi
> user, implementasi TIDAK dilakukan di sesi perencanaan ini.

## 0. Temuan audit (2026-11-22, semua diverifikasi live + docs, bukan ingatan)

Audit `packages/upstream-ankr/src/index.ts` + `packages/upstream-core` terhadap
docs `advanced-api/{token,query,nft}-methods` (versi `.md`/`index.md`) dan probe
live endpoint `https://rpc.ankr.com/multichain/{key}`:

| # | Temuan | Bukti | Prioritas |
|---|---|---|---|
| 1 | **`params` dikirim sebagai ARRAY** `[{ blockchain, address, … }]`. Semua metode AAPI mendokumentasikan `params` sebagai **OBJEK**. Endpoint menoleransi array saat ini (server Go meng-unmarshal elemen pertama), jadi test hijau — tapi itu bukan kontrak; bisa ditolak kapan saja. | Contoh resmi docs & user: `"params": { "address": "0x…", "blockchain": ["eth"] }`; probe live: ketiga bentuk (objek / objek+array blockchain / array berisi objek) diterima endpoint hari ini | **Fatal** — sesuai docs, bukan hanya "yang berjalan" |
| 2 | **`pageSize` kanonik maks 1000, upstream `ankr_getNFTsByOwner` maks 50** (docs: `default=10, max=50`). `pageSize: 60` akan gagal `-32602` dari provider — dan tiap percobaan gagal tetap dibayar 700 credit. | docs nft-methods §ankr_getNFTsByOwner | Tinggi |
| 3 | Endpoint multichain + `blockchain` di param data | notes-m0 §1 + docs semua metode | ✅ sudah benar |
| 4 | `tokenId` dikirim sebagai STRING (docs bilang integer — docs SALAH; number ditolak `-32602` `cannot unmarshal number into Go struct field alias.tokenId of type string`) | probe live A/B/C/D 2026-11-22 | ✅ sudah benar, pertahankan |
| 5 | `filter` array-of-maps, cost `ankr_get*` = 700, capsig `-32075`, derive `value` dari `valueRawInteger` (bukan field `value` Ankr yang terbukti bisa salah 10×), alias chain | notes-m0 §3–§5 | ✅ sudah benar |

**Root cause #1 ada di KONTRAK CORE, bukan di package:** `MethodTranslation.mapRequest`
bertipe `unknown[]` (namespace.ts:55) dan `OutboundItem.params` juga `unknown[]`
(pool.ts:93-98); pool mengirim `params` apa adanya ke body JSON-RPC (pool.ts:663-671).
Kontrak memaksa array — padahal JSON-RPC 2.0 sah untuk `params` objek, dan
`types/jsonrpc.ts:20` (`params?: unknown[] | Record<string, unknown>`) sudah mengakui itu.

## 1. Keputusan desain (diambil, jangan diubah tanpa user)

- **D1 — `mapRequest` mengembalikan `unknown`.** Kontrak diperlonggar: bentuk
  upstream params adalah urusan provider (array posisional utk node API, objek
  utk AAPI). Sisi kanonik TETAP array JSON-RPC dari client. Perubahan minimal,
  tidak menyentuh router/regroup/cost.
- **D2 — Ankr dikirim sebagai OBJEK** sesuai docs, bukan array yang "kebetulan
  diterima". Kepatuhan docs > toleransi server.
- **D3 — `blockchain` dikirim sebagai STRING single-chain** (`"eth"`), bukan array.
  kiseki routing per-chain, instance AAPI satu chain. (Probe live: keduanya
  diterima; docs mencontohkan keduanya. String paling eksplisit.)
- **D4 — pageSize NFT di-clamp + ditolak.** `pageSize > 50` pada
  `kiseki_getNFTsByOwner` → `mapRequest` return `undefined` (invalid params
  client-side, domain error final, TIDAK fetch, TIDAK regroup, 0 credit hangus).
  Clamp diam-diam ditolak karena mengubah makna permintaan client.
- **D5 — respons batch Ankr & segala perilaku lain yang sudah benar (#3–#5) TIDAK
  disentuh.**

## 2. Perubahan core (`packages/upstream-core`) — 3 titik

### 2.1 `src/namespace.ts` (kontrak `MethodTranslation`, ~line 46-73)

```ts
  /**
   * Canonical params → upstream params. `undefined` = invalid canonical
   * params (client error) → domain error entry, NOT a capability mismatch.
   *
   * The return value goes into the JSON-RPC `params` field verbatim
   * (pool.ts `buildRequests`), so it takes whatever shape the provider
   * documents: an array of positional values (the usual node API) or an
   * object with named fields (Ankr Advanced API). The canonical side is
   * always the JSON-RPC array the client sent; only the upstream side is
   * free-form.
   */
  mapRequest(params: readonly unknown[], chain: string): unknown | undefined
```

### 2.2 `src/pool.ts` — `OutboundItem` (line 93-98)

```ts
export type OutboundItem = {
  item: GroupItem
  /** Method actually sent (the upstream name when translated). */
  method: string
  /**
   * The JSON-RPC `params` as the provider wants them: whatever `mapRequest`
   * returned (object or array) for a translated item, the client's array
   * otherwise. JSON-RPC 2.0 allows both.
   */
  params: unknown
}
```

### 2.3 `src/pool.ts` — `prepare()` (line ~243)

```ts
      let mapped: unknown | undefined   // sebelumnya: unknown[] | undefined
```

`buildRequests` (pool.ts:663-671) **tidak berubah** — memang sudah meneruskan
`outbound.params` apa adanya. Tidak ada perubahan lain di core.

### 2.4 Test core yang perlu disesuaikan (2 titik, perilaku tidak berubah)

- `test/pool.test.ts:930` — `mapRequest: (params) => [...params]` tetap valid
  (array masih sah); tambah satu test: translation yang return OBJEK → body
  terkirim dengan `params` objek itu.
- `test/namespace.test.ts` — `makeTranslation` (line 110-132) tetap return array;
  tak wajib diubah. Opsional: satu test mapRequest return objek.

## 3. Perubahan package (`packages/upstream-ankr/src/index.ts`)

### 3.1 Enam `mapRequest`: array → objek

Ubah SEMUA return `mapRequest` dari `return [{ ... }]` menjadi `return { ... }`
(hapus satu lapis array). Pemetaan field TIDAK berubah sama sekali:

| Metode kanonik | Field objek upstream (tidak berubah) |
|---|---|
| `kiseki_getTokenTransfers` | `blockchain`, `address`, `contractAddress?`, `fromBlock?`, `toBlock?`, `pageSize?`, `pageToken?` |
| `kiseki_getTransactionsByAddress` | `blockchain`, `address`, `descOrder: true`, `fromBlock?`, `toBlock?`, `pageSize?`, `pageToken?` |
| `kiseki_getAccountBalance` | `blockchain`, `walletAddress` |
| `kiseki_getNFTsByOwner` | `blockchain`, `walletAddress`, `filter?: [{ [contract]: [] }]`, `pageSize?`, `pageToken?` |
| `kiseki_getNFTMetadata` | `blockchain`, `contractAddress`, `tokenId` (**string** — docs salah; live menolak number) |
| `kiseki_getTokenPrice` | `blockchain`, `contractAddress` |

Perhatian khusus `kiseki_getNFTsByOwner` (D4):

```ts
      // Canonical pageSize may exceed Ankr's max (50, docs nft-methods).
      // Reject instead of clamping: silently widening/trimming the client's
      // request would misrepresent it, and a doomed upstream call would burn
      // 700 credits (notes: invalid params is a FINAL domain error, no fetch).
      if (parsed.pageSize !== undefined && parsed.pageSize > 50) return undefined
```

Tambahkan komentar satu baris di atas `pageSize` pada 4 metode lain yang
meneruskan pageSize: Ankr maksnya jauh di atas kanonik (10000 vs 1000) sehingga
tidak perlu guard.

### 3.2 Komentar header package (setelah `/** kiseki chain name → Ankr … */` sebelum `ANKR_TRANSLATIONS`)

Tambahkan blok penjelasan:

```
 * Ankr Advanced API takes `params` as a single OBJECT with named fields
 * (`{ blockchain, address, … }`), not the positional array of the node API —
 * verified against the docs (advanced-api/{token,query,nft}-methods) and the
 * live endpoint. `mapRequest` therefore returns the object itself; the pool
 * sends it as the JSON-RPC `params` verbatim (namespace.ts: the upstream side
 * is free-form, the canonical side stays the client's array).
```

## 4. Test package yang diubah (`packages/upstream-ankr/test/ankr.test.ts`)

Semua assertion di §3 ("mapRequest: canonical params → Ankr params", line ~341-415)
yang membaca `body.params[0]` diganti `body.params` langsung (karena sekarang
objek). Contoh:

```ts
    expect((body.params as { blockchain: string }).blockchain).toBe("eth")
    // atau, lebih ketat:
    expect(body.params).toEqual({ blockchain: "eth", address: VITALIK })
```

Tes baru yang WAJIB ditambah:

1. **pageSize NFT > 50 ditolak client-side:** `kiseki_getNFTsByOwner` dengan
   `pageSize: 51` → `calls` kosong (tidak fetch), `outcome.kind === "domain_error"`,
   `error.code === -32602`, `final === true`.
2. **pageSize 50 (batas) lolos** dan dikirim apa adanya.
3. **Body params adalah objek:** `expect(Array.isArray(body.params)).toBe(false)`
   untuk satu request kanonik — pin bentuk docs, bukan toleransi server.
4. **Mixed batch tetap benar:** item kanonik (params objek) + item raw `ankr_*`
   (params apa adanya dari client) dalam satu body array — id tetap dicocokkan.
   (Sudah ada test sejenis di §8; tambah asersi bentuk params per item.)

Test yang TIDAK berubah: cost (700/1/override/batch), capability coverage,
capsig (`-32601`, `-32075`, `-32602`→null, `-32090`/`-32000`/`-32052`→null),
mapResponse (fixtures & normalisasi), alias map hygiene.

## 5. Langkah eksekusi (urutan wajib)

1. **M-C (core dulu):** ubah 2.1–2.3 + sesuaikan test core 2.4 → `bun test
   packages/upstream-core` hijau. Commit terpisah: `upstream-core: allow object
   params in MethodTranslation (JSON-RPC 2.0 named fields)`.
2. **M-P (package):** ubah 3.1–3.2 + test 4 → `bun test packages/upstream-ankr`
   hijau. Commit: `upstream-ankr: send AAPI params as an object per docs; clamp
   NFT pageSize via rejection`.
3. **M-V (verifikasi lapangan, butuh apikey di `.env` ANKR1):** jalankan
   integration test yang menembak endpoint sungguhan (pola sudah ada di
   `packages/kiseki/test/ankr-integration.test.ts`) atau minimal satu curl
   dari contoh user di atas, dan pastikan respons sukses dengan body EXACT:
   `"params": { "blockchain": "eth", "address": "0x…", "pageSize": 2 }`.
   Jika endpoint ternyata MENOLAK objek (tak terduga, bertentangan dengan probe
   2026-11-22): STOP, catat di `plan/notes-m0.md` §7, laporkan ke user — jangan
   tambahkan fallback array diam-diam.
4. **M-D (docs):** `docs/upstream-package-guide.md` §5.1 contoh
   `return [{ blockchain, address: parsed.address }]` (line ~298) diganti
   `return { blockchain, address: parsed.address }` + satu kalimat: "bentuk
   params upstream bebas — array posisional (node API) atau objek (Ankr AAPI) —
   sesuai docs provider". Juga baris tabel line ~316: "Body request memakai
   method+params provider" tetap benar, tidak perlu ubah.
5. **M-N (notes):** append §7 di `plan/notes-m0.md` — temuan audit 2026-11-22
   (params objek, clamp NFT, tokenId string dikonfirmasi ulang, toleransi array
   server Go tercatat sebagai fakta, bukan kontrak).
6. `bun run check` penuh (typecheck + 606+ test) → selesai.

## 6. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Server Ankr suatu saat menolak objek (jika kini hanya array yang diterima) | Kontrak docs = objek; probe 2026-11-22 menerima objek. M-V menangkap regresi sebelum merge. |
| Test core lain yang mengasumsikan `params: unknown[]` pada OutboundItem | Cari `\.params\[0\]` di test core; hanya 2 lokasi di 2.4. |
| Package lain (alchemy) terdampak perubahan kontrak | Tidak memakai translations sama sekali (grep: 0 match). Perubahan bersifat widen (`unknown[]` → `unknown`), tidak memecah pemakai lama. |
| Perilaku regroup/cost berubah | Tidak disentuh — perubahan hanya tipe data yang diteruskan; itemCost tetap pakai nama upstream. |

## 7. Invariant yang TIDAK boleh dilanggar (sama dengan Rencana A/B)

- Tidak pernah log token apikey; domain error passthrough verbatim (#36);
  deduct-before-fetch tanpa refund; `mapRequest → undefined` = invalid params
  final TANPA fetch/regroup; matcher capsig konservatif; core tidak pernah
  import package provider (#37).

---

## 8. Catatan implementasi (2026-11-22)

Dikerjakan sesuai urutan M-C → M-P → M-V → M-D → M-N. `bun run check` hijau:
**614 test, 0 fail** (sebelumnya 606; +8 test baru). `bun run build` sukses.

### 8.1 Koreksi terhadap §2.4 (jumlah test yang harus diubah)

§2.4 memperkirakan hanya 2 lokasi di test core. Kenyataannya **5 lokasi di 3
file**. Yang terlewat adalah test milik Rencana A/B:

| File | Lokasi | Tindakan |
|---|---|---|
| `upstream-core/test/pool.test.ts` | ~930 | tetap array (backward-compat) |
| `upstream-core/test/namespace.test.ts` | 306-316, 331 | **tidak diubah** — fixture `makeTranslation` sengaja tetap array, sehingga kedua test ini justru mengunci backward-compat |
| `kiseki/test/ankr-integration.test.ts` | 163-167 | diubah ke objek + asersi bentuk per item di batch campuran |
| `upstream-ankr/test/ankr.test.ts` | 8 assert | diubah ke objek |

Strategi yang dipilih: **(a)** dari review — biarkan `namespace.test.ts` memakai
array. Ini sekaligus membuktikan D1 tidak memecah pemakai lama.

### 8.2 Perbaikan kecil dari review

- Batas NFT diangkat jadi konstanta bernama `ANKR_NFT_MAX_PAGE_SIZE = 50`
  (bukan literal), dengan komentar sumber + tanggal.
- Komentar core tidak menyebut provider spesifik secara eksklusif
  ("e.g. a provider's enhanced API").
- Ditambah test backward-compat eksplisit: `mapRequest` yang mengembalikan
  array **masih** dikirim sebagai array.
- Ditambah test bahwa `pageSize: 1000` pada metode lain **lolos** (tidak
  di-guard berlebihan).

### 8.3 Verifikasi lapangan (M-V)

Keenam metode kanonik dijalankan ke endpoint Ankr nyata dengan params OBJEK:
keenamnya `success` dengan `chain: "ethereum"`. `pageSize: 51` pada NFT →
`domain_error` lokal, kredit `100000 → 100000` (nol hangus).

### 8.4 Known limitation yang diterima (dari review §4.1)

Klien yang mengirim `pageSize: 60` ke `kiseki_getNFTsByOwner` hanya menerima
`-32602 "invalid params"` + `{ method }`, **tanpa** menyebut batas 50 — karena
engine memanggil `invalidCanonicalParams(method)` tanpa `detail`. Memperbaikinya
butuh perubahan kontrak yang lebih besar (mapRequest perlu bisa mengembalikan
error terstruktur). Diputuskan: **tidak** dilakukan di plan ini; didokumentasikan
sebagai batasan. Bila nanti diperlukan, itu plan terpisah.
