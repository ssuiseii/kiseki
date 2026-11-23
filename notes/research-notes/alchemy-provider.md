# Riset Provider: Alchemy (Free tier)

> Status: **temuan lapangan**, 2026-11-22. Bukan dokumen desain — tidak ada
> keputusan arsitektur di sini, hanya fakta terukur + implikasinya.
> Acuan desain tetap `docs/design.md`; rencana kode tetap `docs/implementation.md`.
>
> **Dokumen ini hanya tentang Alchemy.** Riset Ankr ada di file terpisah:
> [`docs/provider-research-ankr.md`](provider-research-ankr.md). Keduanya sengaja
> tidak saling bergantung supaya bisa dibaca dan diperbaiki sendiri-sendiri.

---

## 0. Metodologi & batas kepercayaan

**Cara data diambil.** Semua angka di bawah dari panggilan HTTP nyata ke endpoint
produksi memakai apikey di `.env` (`ALCH_1`, akun Free tier), dari mesin ini,
2026-11-21/22. Tidak ada angka yang disalin dari dokumentasi provider kecuali
yang ditandai eksplisit "dokumen".

**Token tidak pernah ditulis di dokumen ini.** Hanya label `ALCH_1` dan nama
variabel. Ini aturan yang sama dengan `design.md` §18.2.

**Tingkat keyakinan yang dipakai:**

| Tanda | Arti |
|---|---|
| **TERUKUR** | Diulang, hasil konsisten, angka pasti |
| **TERAMATI** | Terlihat jelas, tapi tidak diulang cukup untuk disebut angka pasti |
| **TIDAK KONSISTEN** | Diukur berkali-kali, hasilnya bertentangan — jangan dipakai untuk keputusan |

**Batas yang harus disadari:** ini perilaku satu akun di satu tier pada satu
tanggal. Provider mengubah limit tanpa pemberitahuan. Angka di sini adalah
*observasi*, bukan *kontrak*.

---

## 1. Endpoint & autentikasi

Format: `https://{network}.g.alchemy.com/v2/{apikey}`. Apikey ada di **path**,
bukan header.

Network yang diverifikasi hidup (**TERUKUR**): `eth-mainnet`, `base-mainnet`,
`arb-mainnet`, `polygon-mainnet`.

Apikey salah → **HTTP 401** dengan body JSON-RPC valid (**TERUKUR**):

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Must be authenticated!"}}
```

Perhatikan: kode `-32600`, bukan `-32601` dan bukan `-32000`. Ini penting untuk
klasifikasi error — lihat §6.

---

## 2. Limit laju dan kuota

| Dimensi | Angka | Sumber |
|---|---|---|
| Throughput | 300 CU/s, window bergulir 10 detik | dokumen |
| Request/s ekuivalen | ~15 req/s | dokumen |
| Kuota bulanan | 30 juta CU/bulan | dokumen |

**TERAMATI — throughput tidak seketat dokumen.** Pengukuran:

- 80 request `eth_blockNumber` (10 CU) paralel → **80/80 sukses** (800 CU seketika).
- 120 request `eth_getLogs` (60 CU) dipacu ~12 req/s selama ~10 detik →
  **120/120 sukses**. Itu 7.200 CU dalam ~10 detik = **~720 CU/s**, sekitar
  **2,4× di atas** angka dokumen, tanpa satu pun 429.
- 3 gelombang × 40 `eth_getLogs` paralel: gelombang 1 dan 2 bersih; gelombang 3
  memunculkan 3 kegagalan jaringan (`000`), bukan 429.

**Implikasi:** jangan menyimpulkan "Alchemy longgar, naikkan bucket". Yang benar:
limit *tidak teramati* dalam beban uji ini, jadi **belum ada bukti** bahwa 300 CU/s
itu batas keras. Untuk kiseki tetap pakai angka dokumen (konservatif) — bucket
yang terlalu longgar akan terlihat baik sampai suatu hari 429 muncul di produksi.

**PENTING — kuota bulanan tidak dimodelkan.** Bucket kiseki mengatur *laju*, bukan
*kuota 30 juta CU/bulan*. Proxy tidak akan pernah menolak request karena kuota
bulanan habis; yang terjadi adalah provider menolak, dan itu terlihat sebagai
error biasa. Tidak ada tempat di skema config untuk ini (`design.md` §15).

**Bentuk 429 tidak teramati.** Tidak berhasil dipaksa dalam pengujian ini, jadi
bentuk respons rate-limit Alchemy (header `Retry-After`? kode JSON-RPC?) **belum
diketahui**. Ini lubang data yang jujur harus dicatat: `parseRetryAfter` di kiseki
belum pernah diuji terhadap 429 Alchemy yang asli.

---

## 3. Kemampuan: apa yang benar-benar hidup di Free tier

**TERUKUR** di keempat chain:

| Namespace | Status | Catatan |
|---|---|---|
| `eth_*` | ✅ sebagian | lihat daftar method ditolak di bawah |
| `net_*` | ✅ sebagian | `net_version`, `net_listening` OK; `net_peerCount` ditolak |
| `web3_*` | ✅ | `web3_clientVersion` mengembalikan `reth/v2.10.0-...` |
| `alchemy_*` | ✅ | `getTokenBalances`, `getTokenMetadata`, `getAssetTransfers` hidup |
| `trace_*` | ❌ | ditolak seluruhnya |
| `debug_*` | ❌ | ditolak seluruhnya |

Method yang **ditolak** meski terlihat standar (**TERUKUR**):

| Method | Balasan |
|---|---|
| `net_peerCount` | `-32600` "net_peerCount is not available on the ETH_MAINNET..." |
| `eth_coinbase` | `-32600` "Unsupported method: eth_coinbase on ETH_MAINNET" |
| `eth_mining` | `-32600` |
| `trace_*`, `debug_*` | `-32600` "... is not available on the Free tier ..." |

**Implikasi:** `methods:` di config **tidak boleh** memakai wildcard yang
menyapu method mati. `methods: ["eth_*"]` secara teknis benar (wildcard memang
mencakup `eth_coinbase`), tapi artinya kiseki akan mengklaim bisa melayani
`eth_coinbase` lalu meneruskan `-32600` ke client. Itu dapat diterima — tapi
jangan mengira kiseki akan "mempelajari" method itu mati, karena `-32600` bukan
`-32601` (lihat §6).

Konsekuensi praktis untuk config yang dipakai sekarang: `trace_*` dan `debug_*`
**tidak diklaim sama sekali**, karena memang tidak akan pernah berhasil. Kalau
diklaim, setiap request akan membakar CU lalu gagal.

---

## 4. State arsip

**TERUKUR — arsip penuh, keempat chain.** Metode uji: `totalSupply()` token
stabil di blok lama vs `latest`, harus berbeda.

| Chain | Blok uji | Hasil |
|---|---|---|
| ethereum | `0x1000000` (16,7 jt) | berbeda ✅ |
| base | `0x1000000` | berbeda ✅ |
| arbitrum | `0x4000000` | berbeda ✅ |
| polygon | `0x2000000` | berbeda ✅ |

Batas kedalaman: `eth_call` di **blok 1** (genesis-era) mengembalikan `0x`
(kontrak belum ada) — bukan error "state tidak tersedia". Jadi tidak ada sinyal
pruning sampai sedalam itu. **`archive: true` aman untuk keempat chain.**

---

## 5. `eth_getLogs`: batas 10 BLOK (bukan jumlah hasil)

**TERUKUR — batasnya jumlah blok, dan berlaku di keempat chain.**

| Rentang | Hasil |
|---|---|
| 10 blok inklusif (`0x193d000`..`0x193d009`) | ✅ sukses |
| 11 blok inklusif (`0x193d000`..`0x193d00a`) | ❌ error |

Pesan lengkap (**verbatim**):

```json
{"code":-32600,"message":"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x193d000, 0x193d009]. Upgrade to PAYG for expanded block range."}
```

Diuji juga di base/arbitrum/polygon: pola identik (9 blok ✅, 10–11 blok ❌),
jadi ini batas akun, bukan batas per-chain.

**Implikasi:** batas ini **tidak punya tempat di skema config**. Tidak ada field
untuk "maks rentang blok per method". Jadi penjaganya harus client (minta ≤10
blok), atau kiseki perlu fitur baru: pembatasan/pemecahan rentang `eth_getLogs`
per upstream. Itu perubahan desain, bukan config — catat sebagai kandidat roadmap.

**Efek samping lintas-provider (relevan kalau Ankr juga aktif):** Ankr membatasi
`eth_getLogs` dengan cara berbeda (jumlah *hasil*, bukan jumlah blok). Kalau
keduanya mengklaim `eth_*`, request yang sama bisa sukses atau gagal tergantung
upstream yang dipilih router. Detailnya di dokumen Ankr §7; ringkasnya: 6 request
identik lewat proxy → 2 sukses, 4 gagal.

---

## 6. ⚠️ TEMUAN: pola plan-gate di `upstream-alchemy` tidak cocok dengan pesan asli

Ini temuan yang paling berdampak dari riset ini.

`packages/upstream-alchemy/src/index.ts` baris 138:

```ts
const PLAN_GATED_PATTERN = /(?:not available on (?:the )?free plan|paid plan|upgrade to (?:a )?paid)/
```

Pesan asli Alchemy (**verbatim**, dari §3 dan §5):

- `"trace_block is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access."`
- `"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. ... Upgrade to PAYG for expanded block range."`

Regex menuntut `free plan` / `paid plan` / `upgrade to paid`. Pesan asli memakai
`Free tier` / `Pay As You Go` / `PAYG`. **Tidak ada yang cocok.**

Diverifikasi dengan memanggil matcher langsung memakai pesan asli:

| Pesan asli | `matchAlchemyCapability` |
|---|---|
| `trace_block is not available on the Free tier ...` | `null` ❌ |
| `... up to a 10 block range ... Upgrade to PAYG ...` | `null` ❌ |
| `debug_traceTransaction is not available on the Free tier ...` | `null` ❌ |

Dan diverifikasi end-to-end lewat proxy (config uji yang **mengklaim** `trace_*`):
error `-32600` diteruskan apa adanya ke client, **tanpa** runtime note dan
**tanpa** regroup. Artinya upstream yang sudah terbukti tidak bisa melayani
method itu akan dicoba lagi di request berikutnya, gagal lagi, selamanya.

**Kenapa ini penting melampaui satu regex.** Ini persis pelajaran yang sudah
ditulis sendiri di `plan/notes-m0.md` §3 untuk Ankr:

> "Contoh regex di guide ... **tidak terverifikasi** dan tidak boleh dipakai."

Untuk Ankr, pelajaran itu diterapkan (matcher Ankr sengaja konservatif). Untuk
Alchemy, pola yang sama terulang: regex ditulis dari bayangan, bukan dari respons
asli. Dan semua test tetap hijau karena test memakai pesan karangan sendiri —
tautologi yang sama seperti cacat `params` di `plan/notes-m0.md` §7.1.

**Catatan tambahan:** kode `-32600` juga berarti `isMethodNotFound` (yang hanya
memeriksa `-32601`) tidak akan menangkapnya. Jadi jalur "mismatch" satu-satunya
untuk kasus ini adalah regex di atas — yang tidak cocok.

**Perbaikan yang mungkin (belum dikerjakan, keputusanmu):**

1. Ganti pola jadi sesuatu yang benar-benar muncul, mis. `free tier` +
   `pay as you go|payg`, **dan** tambahkan `unsupported method` /
   `is not available on the` untuk menangkap method mati.
2. Tambahkan test yang memakai **string respons asli** (salin verbatim dari
   dokumen ini) — bukan pesan karangan.
3. Pertimbangkan menangani `-32600` + pola tersebut sebagai `method`, karena
   `-32601` tidak dipakai Alchemy untuk kasus ini.

---

## 7. Batch

**TERUKUR — didukung penuh.** Array masuk, array keluar, `id` dipertahankan,
urutan sesuai. Contoh:

```
kirim : [{"id":1,"method":"eth_chainId"},{"id":2,"method":"eth_blockNumber"}]
balas : [{"id":1,"result":"0x1"},{"id":2,"result":"0x193d828"}]
```

Alchemy menagih **per item di dalam batch** ("batch | CU of method # times
called"), yang persis sama dengan model deduksi kiseki
(`counts_batch_as_one_request` tidak perlu di-set). Konsisten dengan komentar di
`upstream-alchemy/src/index.ts`.

---

## 8. Tabel CU — spot-check

Tabel di `upstream-alchemy` dicocokkan dengan pengamatan tidak langsung
(perilaku limit), bukan dari dokumentasi ulang. Yang bisa dikonfirmasi:

| Method | CU di tabel | Catatan |
|---|---|---|
| `eth_chainId` | 0 | wajar, tidak terlihat membebani apa pun |
| `eth_blockNumber` | 10 | 80 paralel = 800 CU, tidak kena limit |
| `eth_getLogs` | 60 | 120 dalam 10 dtk = 7.200 CU, tidak kena limit |
| `eth_call` | 26 | tidak diuji terpisah |

Angka-angka ini **tidak terbantahkan** oleh pengukuran, tapi juga tidak
terkonfirmasi ketat — limit tidak pernah tercapai, jadi tidak ada titik kalibrasi.

---

## 9. Daftar tindakan (belum dikerjakan, urut dampak)

Semua ini **usulan**, bukan keputusan. Tidak ada kode yang diubah di sesi ini.

| # | Temuan | Dampak | Bagian |
|---|---|---|---|
| 1 | Regex plan-gate tidak cocok dengan pesan asli | Upstream gagal terus-menerus tanpa pembelajaran; test hijau karena memakai pesan karangan | §6 |
| 2 | Batas 10 blok `eth_getLogs` tidak bisa dinyatakan di config | Client harus tahu sendiri; tidak ada penjagaan | §5 |
| 3 | Kuota bulanan (30 jt CU) tidak dimodelkan | Proxy tidak pernah menolak karena kuota habis | §2 |
| 4 | Bentuk 429 belum pernah teramati | `parseRetryAfter` belum teruji terhadap 429 Alchemy asli | §2 |

**Saran proses:** untuk #1, test sebaiknya memakai string respons **verbatim**
dari dokumen ini. Dua cacat sebelumnya di proyek ini (`params` array, `pageSize`
NFT) lolos justru karena test menulis ekspektasinya sendiri, bukan menyalin dari
provider.

---

## Lampiran: perintah reproduksi

```bash
# muat key tanpa mencetaknya
eval "$(python3 -c "
for l in open('.env'):
    l=l.strip()
    if not l or l.startswith('#'): continue
    k,_,v=l.partition('=')
    print(f'export {k.strip()}={v.strip()}')
")"

# trace_* ditolak di Free tier (-32600, bukan -32601)
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCH_1" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"trace_block","params":["0x193d800"]}'

# eth_getLogs 11 blok: batas 10 blok
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCH_1" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x193d000","toBlock":"0x193d00a"}]}'

# apikey salah: 401 JSON yang valid
curl -s -w ' [HTTP %{http_code}]\n' -X POST "https://eth-mainnet.g.alchemy.com/v2/invalid_key" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Untuk menguji matcher tanpa jaringan, panggil `matchAlchemyCapability` langsung
dengan pesan verbatim dari §6.
