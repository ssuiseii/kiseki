# Review Rencana C (`ankr-params-object-fix.md`) — 2026-11-22

Reviewer: sesi implementasi Rencana B. Semua klaim di bawah **diverifikasi ulang
sendiri** (probe live + baca kode), bukan menerima isi plan apa adanya.

---

## 1. Verdict

**Rencana C layak dieksekusi.** Root cause-nya benar, perubahan core-nya minimal
dan tepat sasaran, dan keputusan D1–D5 semuanya bisa saya setujui. Saya tidak
menemukan cacat desain.

Tapi ada **1 hal yang bisa membuat M-P gagal di tengah jalan** (jumlah file test
yang harus diubah jauh lebih banyak dari yang plan sebut), plus **3 hal kecil**
yang sebaiknya diputuskan sebelum coding. Semua di bawah.

---

## 2. Verifikasi klaim plan (semua TERBUKTI)

| Klaim plan | Hasil verifikasi | Catatan |
|---|---|---|
| #1 params AAPI didokumentasikan sebagai OBJEK | ✅ Benar | Keenam metode sukses dengan params objek + `blockchain` string |
| #2 `ankr_getNFTsByOwner` maks 50 | ✅ Benar, dan **lebih tegas dari dugaan** | `pageSize: 51` → `-32602 "pageSize 51 can't be greater than 50"`; `50` → sukses. Jadi ini hard-reject, bukan silent clamp. |
| #3 multichain + `blockchain` di param | ✅ Benar | |
| #4 `tokenId` STRING (docs salah) | ✅ Benar | `tokenId: 1` (number) → `-32602 "json: cannot unmarshal number into Go struct field alias.tokenId of type string"`; `"1"` → sukses |
| #5 cost/capsig/derive value/alias | ✅ Benar | |
| `jsonrpc.ts:20` sudah `unknown[] \| Record` | ✅ Benar | Kontrak core memang sudah mengakui objek |
| Hanya alchemy & generic yang tidak memakai translations | ✅ Benar | `grep translations` → hanya `upstream-ankr` |

**Klaim yang TIDAK terbukti (tapi tidak merusak rencana):** #1 menyebut "server
Go meng-unmarshal elemen pertama" sebagai alasan array masih diterima. Saya tidak
membuktikan mekanisme internalnya — hanya bahwa array memang diterima hari ini.
Tidak masalah: D2 tetap benar karena docs = objek.

---

## 3. TEMUAN UTAMA — §2.4 & §4 understate jumlah test yang harus diubah

Plan bilang: *"Cari `\.params\[0\]` di test core; hanya 2 lokasi di 2.4."*
Itu **tidak cukup**. Ada 3 file test yang assert `params` berbentuk array dan
akan gagal setelah M-P:

| File | Lokasi | Jenis | Disebut plan? |
|---|---|---|---|
| `packages/upstream-core/test/pool.test.ts` | ~930 | `mapRequest: (params) => [...params]` | ✅ ya |
| `packages/upstream-core/test/namespace.test.ts` | 306-316 | `expect(body).toEqual({ … params: [{…}] })` | ❌ **tidak** |
| `packages/upstream-core/test/namespace.test.ts` | 331 | `params[0]!.blockchain` | ❌ **tidak** |
| `packages/kiseki/test/ankr-integration.test.ts` | 163-167 | `expect(bodies[0]).toEqual({ … params: [{ blockchain: "eth", address }] })` | ❌ **tidak** |
| `packages/upstream-ankr/test/ankr.test.ts` | 351-413 (8 assert) | `body.params[0]` | ✅ ya (§4) |

**Kenapa ini penting:** `namespace.test.ts` dan `ankr-integration.test.ts` adalah
test **milik Rencana A dan B**, yang keduanya sudah "selesai". Kalau M-P dijalankan
hanya mengikuti §2.4+§4, `bun run check` akan merah di dua file yang plan tidak
sebut, dan orang yang mengeksekusi akan bingung apakah itu regresi atau ekspektasi
yang perlu diperbarui.

**Rekomendasi:** tambahkan ke §2.4 dan §5 langkah eksplisit: `grep -rn "params:
\[{" packages/*/test/` **dan** `grep -rn "\.params\[0\]" packages/*/test/`,
lalu perbarui semuanya. Total ~5 lokasi di 3 file (bukan 2).

Catatan: `namespace.test.ts` memakai fixture `makeTranslation` sendiri (bukan
package Ankr). Fixture itu **boleh tetap mengembalikan array** — justru bagus,
karena membuktikan kontrak masih menerima array (backward-compat D1). Yang harus
diubah hanya **ekspektasi body** di 306-316 & 331 **jika** fixture diubah ke
objek; kalau fixture dibiarkan array, dua test itu tidak perlu disentuh. Jadi
sebenarnya ada dua strategi — plan perlu **memilih** salah satunya:

- (a) biarkan `makeTranslation` return array → 0 perubahan di namespace.test.ts,
  dan tambah 1 test baru "objek juga diterima" (rekomendasi saya), atau
- (b) ubah `makeTranslation` ke objek → ubah juga 2 ekspektasi body.

Saya sarankan **(a)**: lebih kecil risikonya, dan sekaligus mengunci
backward-compat.

---

## 4. Temuan kecil yang sebaiknya diputuskan

### 4.1 Error message untuk pageSize > 50 tidak informatif

D4 mengembalikan `undefined` → engine menjawab `invalidCanonicalParams(method)`
tanpa `detail` (pool.ts:257 tidak meneruskan detail). Klien yang mengirim
`pageSize: 60` hanya dapat `-32602 "invalid params"` + `{ method }`, **tanpa tahu
batasnya 50**. Padahal `invalidCanonicalParams(method, detail?)` sudah mendukung
`detail`, dan panduannya bilang detail hanya boleh menyebut NAMA FIELD, bukan nilai.

**Rekomendasi (opsional, keputusan user):** teruskan detail dari `mapRequest`.
Tapi itu berarti mengubah kontrak lagi (mis. `mapRequest` mengembalikan
`{ params } | { error: JsonRpcError }`) — **terlalu besar untuk manfaat sekecil
itu**. Alternatif murah: **jangan** ubah kontrak; cukup dokumentasikan di guide
bahwa `-32602` tanpa detail berarti "params kanonik tidak bisa dipetakan".
Kalau user ingin pesan jelas, itu plan terpisah.

**Keputusan yang saya sarankan: terima keterbatasan ini, catat sebagai known
limitation.** Jangan mengubah kontrak untuk ini.

### 4.2 §2.1 doc-comment menyebut "Ankr Advanced API" di file core

Komentar yang diusulkan plan di `namespace.ts` berbunyi *"…or an object with
named fields (Ankr Advanced API)"*. Menyebut provider spesifik di kontrak core
sedikit melanggar netralitas core (design.md: core provider-agnostic). **Saran:**
ganti jadi *"…or an object with named fields (e.g. Ankr's Advanced API)"* atau
tanpa contoh sama sekali. Kosmetik, tapi murah dan menjaga disiplin arsitektur.

### 4.3 Guard pageSize sebaiknya generik, bukan hardcode 50 di dalam mapRequest

Plan menaruh `if (parsed.pageSize > 50) return undefined` langsung di dalam
`mapRequest` NFT. Itu benar, tapi angka `50` jadi literal tanpa nama. **Saran:**
angkat jadi konstanta bernama di dekat schema, mis.
`const ANKR_NFT_MAX_PAGE_SIZE = 50`, dengan komentar sumber docs + tanggal. Ini
konsisten dengan kebiasaan repo (cost table mengutip sumber).

Bonus: saya sudah probe `ankr_getTokenTransfers` & `ankr_getTransactionsByAddress`
dengan `pageSize: 1000` **dan** `1001` — keduanya **sukses**, jadi memang tidak
ada cap bawah 1000 yang perlu dijaga (klaim plan §3.1 benar). Tidak perlu guard
di 4 metode lain.

---

## 5. Hal yang plan sudah benar dan JANGAN diubah

- D1 (`unknown`) — perluasan tipe yang aman; `buildRequests` sudah meneruskan
  `outbound.params` apa adanya (pool.ts:668), jadi **nol perubahan** di sana.
- D3 `blockchain` string — terverifikasi, dan konsisten dengan routing per-chain.
- D4 menolak (bukan clamp) — benar: clamp diam-diam mengubah makna permintaan
  client, dan percobaan yang gagal tetap dibayar 700 kredit.
- D5 tidak menyentuh mapResponse — benar, semua fixture & normalisasi sudah
  terverifikasi live di sesi sebelumnya.
- Urutan M-C sebelum M-P — benar, dan commit terpisah juga benar.

---

## 6. Satu pertanyaan terbuka untuk planner/user

**Apakah `pageSize > 50` untuk NFT benar-benar harus error, atau boleh di-clamp
ke 50 dengan peringatan?**

Plan memilih **error** (D4) dengan alasan "mengubah makna permintaan client".
Saya setuju untuk v1. Tapi perlu dicatat konsekuensinya: klien yang ingin
"ambil sebanyak mungkin" dan mengirim `pageSize: 1000` (nilai maks kanonik yang
sah untuk 5 metode lain) akan **gagal hanya pada metode NFT** — asimetri yang
mungkin mengejutkan. Alternatif: klien NFT cukup tidak mengirim `pageSize`
(default Ankr 10) dan melakukan paging lewat `nextPage`. Tidak ada yang salah
dengan D4; ini hanya perlu **didokumentasikan di guide/README** sebagai
perbedaan antar-metode, supaya tidak jadi jebakan.

---

## 7. Ringkasan tindakan yang saya sarankan ke plan

1. **Wajib:** perbaiki §2.4/§5 — daftar lengkap 3 file test (5 lokasi), dan
   pilih strategi (a) atau (b) untuk `namespace.test.ts`.
2. **Wajib:** §4 tambah test yang memastikan **array tetap sah** (backward-compat
   D1) — bukan hanya test objek.
3. **Disarankan:** §4.3 konstanta bernama untuk batas 50.
4. **Opsional:** §4.2 netralkan komentar core; §6 catat asimetri pageSize di docs.
5. **Tidak perlu:** §4.1 (pesan error detail) — terima sebagai known limitation.
