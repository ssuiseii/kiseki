# Riset Provider: Ankr (Freemium)

> Status: **temuan lapangan**, 2026-11-22. Bukan dokumen desain — tidak ada
> keputusan arsitektur di sini, hanya fakta terukur + implikasinya.
> Acuan desain tetap `docs/design.md`; rencana kode tetap `docs/implementation.md`.
>
> **Dokumen ini hanya tentang Ankr.** Riset Alchemy ada di file terpisah:
> [`docs/provider-research-alchemy.md`](provider-research-alchemy.md). Keduanya
> sengaja tidak saling bergantung supaya bisa dibaca dan diperbaiki sendiri-sendiri.

---

## 0. Metodologi & batas kepercayaan

**Cara data diambil.** Semua angka di bawah dari panggilan HTTP nyata ke endpoint
produksi memakai apikey di `.env` (`ANKR1`, akun Freemium), dari mesin ini,
2026-11-21/22. Tidak ada angka yang disalin dari dokumentasi provider kecuali
yang ditandai eksplisit "dokumen".

**Token tidak pernah ditulis di dokumen ini.** Hanya label `ANKR1` dan nama
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

## 1. Dua endpoint yang saling menolak

Ini fakta paling menentukan bentuk config Ankr, dan **diverifikasi ulang** di
sesi ini (bukan sekadar mengutip `plan/notes-m0.md`).

| URL | `eth_blockNumber` | `ankr_getTokenPrice` |
|---|---|---|
| `https://rpc.ankr.com/eth/{key}` | ✅ | ❌ `-32601 "Method not found"` |
| `https://rpc.ankr.com/multichain/{key}` | ❌ `-32601 "the method eth_blockNumber does not exist/is not available"` | ✅ |

**Implikasi:** satu instance config = satu `url_template`, jadi **Ankr wajib dua
instance per chain**: satu `package: ankr` ke `/multichain/`, satu
`package: generic` ke endpoint per-chain. `provider:` keduanya **harus berbeda**
(`ankr-aapi` vs `ankr-node`) karena satuannya berbeda (kredit vs request) —
kalau disamakan, bucket dibangun ulang dan kredit yang sudah terpakai hilang
(`design.md` §5.4).

---

## 2. Limit laju — angka dan cara mengukurnya

### 2.1 Node API — TERUKUR 30 req/s

- 34 req/s bertahan ~6 detik → 200/200 semua.
- 100 request paralel → 100/100 sukses.
- 60 request paralel → semua 200, tidak ada 429 sama sekali.

Tidak berhasil dipaksa 429 di Node API dalam pengujian ini, jadi **bentuk respons
429 Node API tidak teramati**. Angka 30 req/s berasal dari dokumen dan konsisten
dengan pengamatan (tidak pernah tertembus).

### 2.2 Advanced API — TERUKUR ~30 req/menit, dengan burst

- Paced 1 request / 2 detik (= 30/menit) selama 12 request → **12/12 sukses**.
- Dari window bersih, request beruntun: **11 sukses, ke-12 kena 429**.
- Paced 1 / 0,4 detik → hanya 21/50 sukses.

**Bentuk 429 AAPI (TERUKUR, verbatim):**

```
HTTP/2 429
{"id":null,"jsonrpc":"2.0","error":{"code":-32090,"message":"Too many requests, reason: call rate limit exhausted, retry in 10s","data":{"trace_id":"..."}}}
```

**Tidak ada header `Retry-After`** dan tidak ada `X-RateLimit-*`. Satu-satunya
petunjuk waktu ada di teks pesan ("retry in 10s"). Ini penting untuk
`parseRetryAfter` di kiseki: tidak akan menemukan header, jadi estimasi harus
dari bucket — yang memang sudah jadi desain `design.md` §12.

Perhatikan juga `"id":null` pada 429: Ankr tidak mempertahankan `id` request saat
kena limit. Untuk batch, ini berarti error-nya tidak bisa dipetakan per item
lewat `id` — harus diperlakukan sebagai kegagalan seluruh body.

---

## 3. Biaya kredit Advanced API

**Dokumen:** 700 API kredit per panggilan AAPI; Node API (EVM) 200 kredit.
**Freemium:** 200 juta kredit/bulan.

**Implikasi untuk bucket:** bucket AAPI harus diukur dalam **kredit**, bukan
request. `upstream-ankr` sudah memetakan `ankr_get* → 700`, dan engine menagih
memakai nama upstream, jadi `kiseki_getTokenTransfer` ikut tertagih 700 tanpa
entri tambahan. Konsisten.

Angka config yang dipakai sekarang: `capacity 3500` (burst 5) dan
`refill 350/s` (= 0,5 AAPI/s = 30/menit). Cocok dengan pengukuran burst di §2.2.

**Kuota bulanan tidak dimodelkan** (sama seperti Alchemy): 200 juta kredit/bulan
tidak punya tempat di skema config. Bucket mengatur laju, bukan kuota.

---

## 4. Akuntansi batch AAPI — TIDAK KONSISTEN

Ini satu-satunya hal di dokumen yang tidak bisa aku simpulkan, dan aku tulis apa
adanya daripada memaksakan angka.

Pertanyaannya: kalau satu body berisi N item `ankr_*`, apakah dihitung 1 request
atau N? Pengukuran dari window bersih (idle 75–150 detik sebelum tiap uji):

| Uji | Item yang lolos sebelum 429 |
|---|---|
| Single, beruntun | 11 |
| Batch 2 item, beruntun | 6 |
| Batch 4 item, beruntun | 8 |
| Batch 5 item, satu body, window bersih | **0** (429 langsung) |
| Batch 3 item, satu body, window bersih | 3 (sukses) |
| Batch 4 item, satu body, window bersih | 4 (sukses) |

Kalau dihitung per item, semua baris harusnya ~11. Kalau dihitung per HTTP call,
batch 5 harusnya sukses. **Keduanya tidak terpenuhi.** Kemungkinan penyebab:
sisa pemakaian dari uji sebelumnya (window tidak benar-benar bersih), atau
pembobotan internal Ankr yang tidak terlihat dari luar.

**Rekomendasi:** anggap **N item × 700 kredit** (konservatif, sama dengan
`chargeFor` yang sudah menjumlahkan per item). Jangan membangun logika apa pun
yang bergantung pada asumsi "batch = 1 request" untuk AAPI.

---

## 5. ⚠️ Apikey salah → HTML 404 nginx, bukan JSON-RPC

**TERUKUR di kedua endpoint Ankr:**

```html
<html><head><title>404 Not Found</title></head>
<body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>
```

HTTP 404, `content-type: text/html`. Bukan JSON sama sekali.

**Perilaku kiseki saat ini (diverifikasi end-to-end):** upstream ditandai
`sick`, dan client menerima:

```json
{"code":-32006,"message":"no healthy upstream available"}   [HTTP 429]
```

**Dua masalah di sini:**

1. **Diagnosis menyesatkan.** Client melihat 429 (rate limit) padahal penyebabnya
   apikey salah. Operator yang melihat 429 akan menaikkan bucket, bukan
   memeriksa `.env`. Log memang menulis `"upstream sick"`, tapi client tidak.
2. **Kegagalan konfigurasi menyamar jadi kegagalan kapasitas.** Ini kelas bug
   yang mahal karena mengarahkan troubleshooting ke tempat yang salah.

**Catatan pembanding:** Alchemy membalas apikey salah dengan **401 JSON yang
valid**, sehingga kiseki bisa membedakannya. Ankr tidak memberi kesempatan itu.

**Kandidat perbaikan (belum dikerjakan):** deteksi `content-type: text/html`
atau body non-JSON dari upstream sebagai *config error*, bukan *rate limit* —
dan laporkan sebagai error yang menyebut upstream-nya, bukan `429`.

---

## 6. Method yang dinonaktifkan di Node API

**TERUKUR** — kode `-32075`, dua varian pesan:

| Method | Balasan |
|---|---|
| `eth_accounts` | `-32075 "Method disabled"` |
| `net_peerCount` | `-32075 "Method disabled, reason: restricted by blockchain schema"` |
| `eth_mining` | `-32075 "Method disabled, reason: restricted by blockchain schema"` |
| `eth_coinbase` | `-32075 "Method disabled, reason: restricted by blockchain schema"` |

`matchAnkrCapability` **sudah** menangani `-32075` sebagai `method` mismatch ✅
(diverifikasi dengan memanggil matcher langsung). Jadi untuk instance
`package: ankr`, ini memicu regroup dengan benar.

**Tapi** instance Node API memakai `package: generic`, yang tidak punya matcher
`-32075`. Akibatnya error diteruskan apa adanya ke client (diverifikasi lewat
proxy). Untuk kasus ini itu **perilaku yang benar**: `-32075` adalah pernyataan
tentang method di endpoint ini, dan tidak ada upstream lain yang bisa melayani
`eth_accounts` juga. Regroup hanya akan membakar kuota.

---

## 7. `trace_*` / `debug_*` di Node API

**TERUKUR:** `-32053 "API key is not allowed to access method"`.

Kode ini **tidak** ada di `matchAnkrCapability` (yang hanya menangani `-32601`
dan `-32075`), jadi diteruskan ke client. Diverifikasi lewat proxy dengan config
uji yang mengklaim `trace_*`: error `-32053` sampai ke client apa adanya, tanpa
regroup.

**Penilaian:** untuk kasus ini tidak apa-apa (tidak ada upstream yang bisa
melayani `trace_*` di setup ini), **tapi** kalau nanti ada provider berbayar yang
bisa, `-32053` seharusnya jadi sinyal `method` mismatch agar item di-regroup ke
provider itu. Catat sebagai kandidat, bukan bug hari ini.

---

## 8. `eth_getLogs`: batas jumlah HASIL, bukan jumlah blok

**TERUKUR** — berbeda mendasar dari Alchemy:

| Rentang | Hasil |
|---|---|
| 2 blok | ✅ |
| 5 blok | ✅ |
| 10 blok (tanpa filter address) | ❌ `-32200` |
| 10 blok + filter `address` | ✅ |

Pesan (**verbatim**):

```json
{"code":-32200,"message":"query exceeds max results 10000, retry with the range 26464256-26464264"}
```

Ankr bahkan **memberi tahu rentang yang disarankan** dalam pesannya. Batasnya
10.000 hasil, jadi rentang blok yang lolos bergantung pada kepadatan log.

**Efek samping lintas-provider (relevan kalau Alchemy juga aktif):** karena
Alchemy membatasi dengan cara berbeda (jumlah *blok*), dan keduanya mengklaim
`eth_*`, request yang sama bisa sukses atau gagal tergantung upstream yang
dipilih router. Terbukti: 6 request identik lewat proxy → 2 sukses, 4 gagal
`-32200`.

---

## 9. State arsip

**TERUKUR** — arsip hidup, setara Alchemy. `totalSupply()` di blok lama berbeda
dari `latest` di ethereum, polygon, arbitrum, base. `eth_call` di blok 1
mengembalikan `0x` (sama seperti Alchemy — kontrak belum ada, bukan pruning).

`archive: true` aman untuk instance Node API.

---

## 10. Batch

**TERUKUR — didukung** di kedua endpoint. Array masuk, array keluar, `id` cocok.
Untuk AAPI, batas laju berlaku (lihat §4).

---

## 11. Daftar tindakan (belum dikerjakan, urut dampak)

Semua ini **usulan**, bukan keputusan. Tidak ada kode yang diubah di sesi ini.

| # | Temuan | Dampak | Bagian |
|---|---|---|---|
| 1 | Apikey salah → HTML 404 → dilaporkan sebagai 429 | Salah diagnosis: masalah config terlihat seperti masalah kapasitas | §5 |
| 2 | `-32053` tidak dikenali sebagai `method` mismatch | Tidak ada regroup kalau nanti ada provider yang bisa | §7 |
| 3 | Akuntansi batch AAPI tidak konsisten | Sudah ditangani konservatif; jangan dioptimalkan | §4 |
| 4 | Bentuk 429 Node API belum teramati | `parseRetryAfter` belum teruji di jalur Node API | §2.1 |

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

# dua endpoint, dua perilaku
curl -s -X POST "https://rpc.ankr.com/eth/$ANKR1" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"trace_block","params":["0x193d800"]}'

curl -s -X POST "https://rpc.ankr.com/multichain/$ANKR1" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# method dinonaktifkan (-32075)
curl -s -X POST "https://rpc.ankr.com/eth/$ANKR1" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_accounts","params":[]}'

# apikey salah: HTML 404, bukan JSON
curl -s -w ' [HTTP %{http_code}]\n' -X POST "https://rpc.ankr.com/eth/invalid_key" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Untuk menguji matcher tanpa jaringan, panggil `matchAnkrCapability` langsung
dengan pesan verbatim dari §6 dan §7.
