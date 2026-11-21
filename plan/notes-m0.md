# Catatan M0 — Verifikasi lapangan Ankr (2026-11-21/22)

Semua hasil di bawah dari **panggilan nyata** dengan apikey di `.env`
(`ANKR1`, tidak ditulis di sini). Endpoint dipanggil dari mesin ini, waktu
respons 10 ms – 900 ms.

---

## 1. F4 TERBUKTI SALAH: AAPI tidak dilayani endpoint per-chain

Ini temuan yang membatalkan asumsi F4 di `plan/ankr-advanced-api.md` §0.1.

| URL | `eth_blockNumber` | `ankr_getTokenTransfers` |
|---|---|---|
| `https://rpc.ankr.com/eth/{key}` | ✅ `0x193d1c8` | ❌ `-32601 "Method not found"` |
| `https://rpc.ankr.com/multichain/{key}` | ❌ `-32601 "the method eth_blockNumber does not exist/is not available"` | ✅ result normal |
| `https://rpc.ankr.com/multichain/eth/{key}` | — | ❌ HTTP 404 (nginx) |
| `https://rpc.ankr.com/eth/multichain/{key}` | — | ❌ HTTP 404 (nginx) |
| `https://rpc.ankr.com/advanced_api/{key}` | — | ❌ HTTP 403 `"API key is not allowed to access blockchain, -32052"` |

**Kesimpulan:** tidak ada satu URL pun yang melayani node API **dan** AAPI.
Dua-duanya endpoint terpisah dan saling menolak (`-32601`), bukan sekadar
"tidak didokumentasikan". Karena satu instance config = satu `url_template`,
**satu instance tidak bisa melayani `eth_*` + `ankr_*` sekaligus**.

Yang tetap benar dari F4: AAPI memakai satu endpoint multichain, dan param
`blockchain` per request — jadi satu instance AAPI secara teknis bisa melayani
banyak chain. Tapi kiseki menyusun upstream per chain, jadi bentuk config-nya
tetap per chain.

**Butuh keputusan user** (lihat ringkasan sesi): dua instance per chain, atau
lain. Package `upstream-ankr` sendiri **tidak terpengaruh** keputusan ini —
translasi hanya memetakan `chain` → alias `blockchain`, tidak peduli URL.

## 2. Batch

`POST /multichain/{key}` menerima array JSON-RPC dan mengembalikan array
berurutan dengan `id` yang sama. Aman untuk batch campuran (engine yang
memisah per group, jadi tidak ada campuran lintas endpoint dalam satu body).

## 3. Signature error nyata (untuk `matchAnkrCapability`)

| Skenario | Code | Pesan (verbatim) | Verdict |
|---|---|---|---|
| Method tak dikenal (multichain) | `-32601` | `the method ankr_doesNotExist does not exist/is not available` | `method` |
| Method tak dikenal (per-chain) | `-32601` | `Method not found` | `method` |
| Method dinonaktifkan untuk chain | `-32075` | `Method disabled, reason: restricted by blockchain schema` | `method` |
| `blockchain` tidak valid | `-32602` | `invalid argument 0: invalid params: invalid blockchain name: invalid params: notachain is not allowed. See: …` | **null** (client error) |
| Tipe param salah | `-32602` | `invalid argument 0: json: cannot unmarshal object into Go struct field alias.filter of type []*map[string][]string` | **null** |
| Param wajib hilang | `-32603` | `internal error` + `data` = trace id | **null** |
| Rate limit | `-32090` | `Too many requests, reason: call rate limit exhausted, retry in 10s` (HTTP 429) | **null** (engine sudah menangani HTTP 429 → `rate_limited`) |
| Apikey tidak valid | `-32000` | `Unauthorized: You must authenticate your request with an API key. …` | **null** |
| Apikey tak boleh chain itu | `-32052` | `API key is not allowed to access blockchain` (HTTP 403) | **null** |

Catatan penting:

- **Pola plan-gate TIDAK berhasil direkam.** Apikey ini punya akses penuh:
  `ankr_getNFTHolders`, `ankr_getTokenHoldersCount`, `ankr_getInteractions`,
  `ankr_getCurrencies`, `ankr_getLogs`, `ankr_getBlocks`,
  `ankr_getTokenPriceHistory` semuanya sukses. Jadi contoh regex di guide
  (`/method not allowed for your (plan|tier)|upgrade your plan/`) **tidak
  terverifikasi** dan tidak boleh dipakai.
- Mitigasi: dua jalur plan-gate yang realistis sudah tertutup tanpa regex
  karangan — `-32601` (method hilang) dan `-32075` (method disabled). Matcher
  sengaja konservatif: selain itu `null`, sesuai §10 risiko plan.
- `-32602` **wajib** `null`. Kalau di-match `method`, request client yang salah
  akan memicu regroup dan membakar kuota 700 per percobaan.

## 4. Bentuk respons nyata (dasar `mapResponse`)

Diambil dari panggilan sungguhan, bukan dari ingatan.

### `ankr_getTokenTransfers`
```
result: { nextPageToken?: string, transfers: [{
  fromAddress, toAddress, contractAddress, value, valueRawInteger,
  blockchain, tokenName, tokenSymbol, tokenDecimals,
  transactionHash, blockHeight (number), logIndex (number),
  timestamp (number, unix detik), direction, thumbnail
}], syncStatus }
```
- `pageSize` default 10000, maks 10000.
- `address` boleh string **atau** array string.
- `fromBlock`/`toBlock` menerima hex, desimal, `"earliest"`, `"latest"`.
  (Filter blok 15000000–15001000 mengembalikan `[]` — bentuk diterima, hasil
  kosong karena memang tak ada transfer di rentang itu.)
- **Selalu** ada `contractAddress` pada 100 transfer pertama; native transfer
  tidak disertakan method ini.

### `ankr_getTransactionsByAddress`
```
result: { nextPageToken?, transactions: [{
  hash, blockNumber (hex string), from, to, value (hex), nonce (hex),
  timestamp (hex string unix, mis. "0x6b015327"), status (hex),
  gas, gasPrice, gasUsed, input, transactionIndex, blockHash,
  cumulativeGasUsed, type, v, r, s, blockchain
}], syncStatus }
```
- `descOrder` diterima. `fromBlock`/`toBlock` diterima. `includeLogs` ada.

### `ankr_getAccountBalance`
```
result: { totalBalanceUsd, totalCount, assets: [{
  blockchain, tokenName, tokenSymbol, tokenDecimals, tokenType,
  contractAddress, holderAddress, balance, balanceRawInteger,
  balanceUsd, tokenPrice, thumbnail
}], nextPageToken?, syncStatus }
```
- `tokenType`: `"NATIVE"` | `"ERC20"` (yang teramati).
- Native memakai `contractAddress = 0x0000000000000000000000000000000000000000`.
- **`pageSize` diabaikan**: `pageSize: 2` dan `pageSize: 50` sama-sama
  mengembalikan 481 aset. Default = semua.

### `ankr_getNFTsByOwner`
```
result: { owner, assets: [{
  blockchain, name, tokenId (string desimal), tokenUrl, imageUrl,
  collectionName, symbol, contractType, contractAddress, traits
}], nextPageToken?, syncStatus }
```
- **`filter` harus ARRAY**, bukan object:
  `filter: [{ "<contract>": [] }]`. Object polos → `-32602`
  `cannot unmarshal object into … []*map[string][]string`.
- `pageSize` default 10, **maks 50**.

### `ankr_getNFTMetadata`
```
result: {
  metadata: { blockchain, contractAddress, tokenId, contractType,
              collectionName, collectionSymbol },
  attributes: { tokenUrl, imageUrl, name, description, contractType },
  syncStatus
}
```
- `attributes.name`/`imageUrl` bisa string kosong (`""`) — jangan diteruskan
  mentah, skema kanonik menolak string kosong.

### `ankr_getTokenPrice`
```
result: { usdPrice (string desimal), blockchain, contractAddress,
          syncStatus: { timestamp (unix detik), blockNumber, lag, status } }
```

## 5. Dua masalah bentuk data yang WAJIB dinormalisasi

### 5.1 `valueRawInteger` adalah DESIMAL, bukan hex
Skema kanonik `TokenAmount.valueRaw` menuntut hex (`0x…`). Ankr memberi string
integer desimal. Jadi `mapResponse` wajib mengonversi:
`"340000000000000000000"` → `"0x126e0f1f4e0e2c0000"`. Murni, tanpa I/O.

### 5.2 Field `value`/`balance` Ankr TIDAK konsisten dengan raw-nya
Contoh nyata satu transfer: `tokenDecimals: 18`, `valueRawInteger:
"340000000000000000000"` (= 340 × 10^18) tetapi `value: "34000000000000000000"`
(= 34 × 10^18). Selisih 10×. Untuk native ETH keduanya konsisten
(`5799563395714210716` / 18 desimal → `5.799563395714210716`, sama dengan field
`balance`).

Keputusan: **`value` kanonik diturunkan dari `valueRawInteger` + `tokenDecimals`,
bukan disalin dari field `value` Ankr.** Alasannya: kanonik harus
self-consistent (`value` = `valueRaw` ÷ 10^decimals), dan field `value` Ankr
terbukti bisa salah. Untuk data yang benar hasilnya identik.

## 6. Catatan lain

- `tokenName`/`tokenSymbol` pada transfer bisa berisi byte NUL
  (`"\u0000\u0000…"`). Tidak dipetakan ke kanonik (skema transfer tidak punya
  field itu), jadi tidak masalah — tapi jangan pernah dipakai sebagai
  `name`/`symbol` tanpa sanitasi.
- `syncStatus.status` = `"synced"`. Tidak dipetakan (tidak ada di skema).
- Rate limit AAPI cukup agresif: beberapa panggilan berurutan langsung
  `-32090` + HTTP 429 dengan `id: null`. Engine sudah menangani HTTP 429 →
  `rate_limited` + failover key, jadi tidak perlu penanganan khusus di package.
- `nextPageToken` bisa absen pada halaman terakhir (`getAccountBalance`), jadi
  `?? null` wajib.

---

## 7. Audit implementasi + probe ulang (2026-11-22, sesi review)

Probe ulang dengan apikey yang sama, endpoint `https://rpc.ankr.com/multichain/{key}`.

### 7.1 `params` OBJEK, bukan array — temuan fatal terhadap implementasi

Semua metode AAPI mendokumentasikan `params` sebagai **objek** (docs
`advanced-api/{token,query,nft}-methods`, contoh resmi + contoh dari user).
Implementasi saat ini mengirim array `[{ … }]` karena kontrak core
`MethodTranslation.mapRequest: unknown[]` memaksanya.

Probe bentuk pada `ankr_getTokenTransfers` (hasil identik, semua diterima):

| Bentuk `params` | Hasil |
|---|---|
| `{ blockchain: "eth", address, pageSize: 2 }` | ✅ sukses |
| `{ blockchain: ["eth"], address, pageSize: 2 }` | ✅ sukses |
| `[{ blockchain: "eth", address, pageSize: 2 }]` (bentuk implementasi sekarang) | ✅ sukses — **toleransi server Go**, bukan kontrak |

Kesimpulan: kepatuhan docs = objek. Array bekerja hari ini dan bisa ditolak
kapan saja tanpa pemberitahuan. Perbaikan ada di Rencana C
(`plan/ankr-params-object-fix.md`): kontrak core diperlonggar ke `unknown`,
package mengirim objek.

### 7.2 `tokenId` — docs SALAH, string yang benar

`ankr_getNFTMetadata`: docs menulis `tokenId` (integer), tetapi live:

- `tokenId: 1` (number) → `-32602` `cannot unmarshal number into Go struct
  field alias.tokenId of type string`
- `tokenId: "1"` dan `tokenId: "<uint256 besar>"` (string) → ✅ sukses

Implementasi yang mengirim string sudah benar; jangan "perbaiki" ke number.

### 7.3 `blockchain` string vs array — keduanya diterima

Docs mencontohkan keduanya. kiseki route per chain → kirim **string** single
chain (paling eksplisit). Tercatat agar tidak ada perdebatan di sesi berikutnya.

### 7.4 `pageSize` `ankr_getNFTsByOwner` maks 50

Docs: `default=10, max=50`. Skema kanonik mengizinkan sampai 1000 → `mapRequest`
wajib MENOLAK `pageSize > 50` (invalid params client-side, final, tanpa fetch)
— bukan clamp diam-diam. Detail di Rencana C §3.1.


---

## 7. Audit lanjutan 2026-11-22 — dua cacat implementasi Rencana B

Ditemukan setelah Rencana B selesai (606 test hijau) oleh audit pihak lain.
Keduanya **nyata** dan sudah diperbaiki lewat Rencana C.

### 7.1 `params` dikirim sebagai ARRAY, padahal docs = OBJEK (fatal)

Implementasi awal mengembalikan `[{ blockchain, address, … }]` dari setiap
`mapRequest`. Docs AAPI mendokumentasikan `params` sebagai objek bernama.

Kenapa lolos dari semua test saat itu — dua kesalahan yang saling menutupi:

1. Endpoint multichain **menoleransi** array hari ini (server Go meng-unmarshal
   elemen pertama), jadi probe live sukses.
2. Test menulis `expect(body.params[0])`, yaitu **menyalin bentuk yang dikirim
   implementasi** ke dalam ekspektasi. Tautologi: membuktikan kode sama dengan
   dirinya sendiri, bukan dengan kontrak.

**Pelajaran:** ekspektasi test harus diambil dari docs/provider, lalu
implementasi dipaksa menyesuaikan. "Server menerima" ≠ "bentuk ini benar".

Root cause sebenarnya ada di **kontrak core**: `mapRequest` bertipe `unknown[]`,
padahal JSON-RPC 2.0 mengizinkan objek (`types/jsonrpc.ts:20` sudah mengakui
`unknown[] | Record<string, unknown>`). Diperbaiki: `mapRequest` → `unknown`,
`OutboundItem.params` → `unknown`. `buildRequests` tidak berubah.

### 7.2 Batas `pageSize` NFT 50 dicatat tapi tidak ditegakkan (tinggi)

§4 dokumen ini **sudah** mencatat `ankr_getNFTsByOwner` maks 50, tetapi kode
tidak menegakkannya. Akibatnya `pageSize: 60` tetap dikirim, ditolak provider
dengan `-32602`, dan **700 kredit tetap hangus** — padahal aturan yang sama
dokumen ini tulis: invalid params = final, tanpa fetch, 0 kredit.

**Pelajaran:** "sudah dicatat" bukan "sudah ditegakkan". Test yang ada hanya
menguji happy path; tidak ada satu pun test yang menguji **batas**.

### 7.3 Fakta tambahan yang diprobe ulang (2026-11-22)

| Probe | Hasil |
|---|---|
| `ankr_getNFTsByOwner` `pageSize: 50` | ✅ sukses |
| `ankr_getNFTsByOwner` `pageSize: 51` | ❌ `-32602 "pageSize 51 can't be greater than 50"` |
| `ankr_getNFTsByOwner` `pageSize: 60` | ❌ `-32602 "pageSize 60 can't be greater than 50"` |
| `ankr_getTokenTransfers` `pageSize: 1000` / `1001` | ✅ sukses keduanya (batas Ankr 10000, di atas maks kanonik 1000) |
| `ankr_getTransactionsByAddress` `pageSize: 1000` / `1001` | ✅ sukses keduanya |
| `ankr_getNFTMetadata` `tokenId: 1` (number) | ❌ `-32602 "json: cannot unmarshal number into Go struct field alias.tokenId of type string"` |
| `ankr_getNFTMetadata` `tokenId: "1"` (string) | ✅ sukses |
| params OBJEK + `blockchain` string, keenam metode | ✅ sukses semua |
| batch 2 request ber-params objek | ✅ array, id cocok |

Kesimpulan: docs Ankr benar tentang **bentuk params** (objek) dan **batas
pageSize NFT**; docs **salah** tentang `tokenId` (bilang integer, endpoint
menuntut string).
