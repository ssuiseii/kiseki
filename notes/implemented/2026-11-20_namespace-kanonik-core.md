# Namespace Kanonik `kiseki_*` untuk Method Non-Standar Provider

| | |
|---|---|
| **Jenis** | Proposal desain |
| **Status** | Diimplementasikan |
| **Tanggal** | 21 November 2026 |
| **Komponen** | `upstream-core` |
| **Proposal lanjutan** | Integrasi Ankr Advanced API (bergantung pada proposal ini) |

---

## Ringkasan

Kiseki saat ini meneruskan method non-standar provider (`ankr_*`, `alchemy_*`, dan seterusnya) apa adanya. Akibatnya, client yang memakai fitur tersebut terikat pada satu provider dan harus tahu plan apa yang aktif di provider itu. Kondisi ini bertentangan dengan alasan utama kiseki ada, yaitu menyembunyikan perbedaan antar provider di balik satu endpoint.

Proposal ini mengusulkan **satu namespace netral, `kiseki_*`**, yang menjadi kontrak publik bagi client. Kiseki menerjemahkan method kanonik ke method asli provider yang mendukungnya, lalu menerjemahkan hasilnya kembali ke bentuk kanonik. Translasi dideklarasikan oleh masing-masing package provider dan dijalankan oleh pool engine di `upstream-core`. **Router, pre-flight, dan grouping tidak perlu diubah.**

Yang diminta dari reviewer adalah persetujuan atas **kontrak** dan **lokasi translasi**. Isi tabel translasi untuk provider tertentu akan diajukan di proposal terpisah.

---

## 1. Masalah

### 1.1 Client terikat pada provider

Method seperti riwayat transfer token, saldo multi-chain, atau metadata NFT tidak ada di JSON-RPC standar. Setiap provider menyediakannya dengan nama, parameter, dan bentuk respons yang berbeda. Client yang memakai `ankr_getTokenTransfers` tidak bisa dialihkan ke provider lain tanpa mengubah kodenya.

### 1.2 Ketersediaan bergantung pada plan

Sebagian method ini hanya aktif di plan berbayar tertentu, dan cakupannya bisa berubah sewaktu-waktu. Client tidak seharusnya perlu tahu plan apikey yang dipakai operator.

### 1.3 Failover tidak berlaku

Kekuatan utama kiseki adalah routing dan failover antar provider. Untuk method non-standar, keunggulan itu hilang: hanya satu provider yang mengenali nama method tersebut, sehingga tidak ada upstream alternatif yang bisa dipakai saat terjadi gangguan atau kuota habis.

---

## 2. Tujuan

1. Client cukup mengenal **satu namespace** untuk fitur non-standar, terlepas dari provider di belakangnya.
2. Method kanonik **mendapat routing dan failover** seperti method standar, ke provider mana pun yang mendukungnya.
3. Menambah provider atau method kanonik baru **tidak memerlukan perubahan pada router atau core**.
4. Perhitungan cost dan kuota tetap **akurat**: yang ditagih adalah biaya method asli provider.

### Bukan tujuan

- Mendefinisikan daftar lengkap method kanonik. Daftar ini akan datang bersama integrasi provider pertama.
- Menerjemahkan error provider. Error tetap diteruskan apa adanya.
- Mendukung provider yang enhanced API-nya berbasis REST. Kontraknya disiapkan, tetapi implementasinya ditunda.

---

## 3. Usulan

### 3.1 Gambaran

```
Client ── kiseki_getTokenTransfers ──▶ Router (tidak berubah)
                                          │  melihat method ini sebagai
                                          │  "dicover" oleh provider X
                                          ▼
                                 Pool provider X
                       ┌──────────────────┼──────────────────┐
                       ▼                  ▼                  ▼
                 terjemahkan          hitung cost        terjemahkan
                 request ke           memakai nama       hasil ke
                 method asli          method asli        bentuk kanonik
```

Bagi router, `kiseki_getTokenTransfers` hanyalah method biasa yang kebetulan didukung oleh sebagian provider. Seluruh logika translasi berada di dalam pool.

### 3.2 Kontrak

Setiap package provider dapat mendeklarasikan daftar translasi:

```ts
export type MethodTranslation = {
  /** Method kanonik, mis. "kiseki_getTokenTransfers". */
  canonical: string
  /** Method asli provider, mis. "ankr_getTokenTransfers". */
  upstream: string
  /** Params kanonik → params provider. `undefined` = params tidak valid. */
  mapRequest(params: readonly unknown[], chain: string): unknown[] | undefined
  /** Hasil provider → hasil kanonik. Hanya untuk respons sukses. */
  mapResponse(result: unknown, params: readonly unknown[]): unknown
  /** Default "jsonrpc". "http" dicadangkan untuk provider berbasis REST. */
  transport?: "jsonrpc" | "http"
}

export type NamespaceHooks = {
  translations?: readonly MethodTranslation[]
}
```

Provider yang tidak mendeklarasikan translasi tidak terpengaruh sama sekali.

### 3.3 Perilaku pool engine

| Aspek | Perilaku |
|---|---|
| **Capability** | Sebuah method kanonik dianggap didukung provider jika provider tersebut mendeklarasikan translasinya **dan** method aslinya tercakup dalam konfigurasi method provider. Tanpa translasi, method kanonik ditolak dengan `-32601` seperti method tak dikenal lainnya. |
| **Request** | Item kanonik dikirim ke provider dengan nama dan parameter hasil `mapRequest`. Parameter tidak valid langsung dijawab sebagai error untuk item tersebut, tanpa menghubungi provider. |
| **Response** | Hasil sukses diterjemahkan dengan `mapResponse`. Error provider diteruskan tanpa diubah. |
| **Cost** | Biaya dihitung berdasarkan nama method asli, sehingga tarif provider yang sebenarnya tetap berlaku. |
| **Failover** | Jika provider menolak karena batas plan, item dialihkan ke provider lain yang mendukung method kanonik yang sama, memakai mekanisme regroup yang sudah ada. |

### 3.4 Skema kanonik

Bentuk parameter dan hasil setiap method `kiseki_*` didefinisikan sekali di `upstream-core` dalam bentuk skema Zod, lalu dipakai oleh semua package provider. Kaidahnya:

- **Ketat:** field yang tidak dikenal ditolak.
- **Alamat, hash, dan quantity** divalidasi dengan format eksplisit.
- **Nilai token** memakai string desimal disertai nilai mentah dalam hex. Tidak boleh memakai `number` JavaScript, karena nilai Wei bisa kehilangan presisi.
- **Paging** memakai token `nextPage` yang opaque, dikembalikan client apa adanya.
- **Nama chain** memakai nama kiseki (`ethereum`). Alias provider (`eth`, `bsc`) ditolak supaya tidak bocor ke client.

---

## 4. Alternatif yang Dipertimbangkan

| Alternatif | Alasan tidak dipilih |
|---|---|
| **A. Tetap meneruskan method provider apa adanya** (kondisi sekarang) | Tidak menyelesaikan masalah keterikatan, ketergantungan plan, maupun hilangnya failover. |
| **B. Translasi di router atau server kiseki** | Router jadi harus mengenal detail tiap provider, padahal tugasnya hanya memilih provider. Melanggar aturan bahwa router tidak bergantung pada package provider, dan memperbesar area perubahan. |
| **C. Satu tabel translasi global di core** | Core jadi harus tahu detail semua provider. Setiap perubahan plan atau API provider memaksa perubahan di core. |
| **D. Tabel milik package provider, eksekusi di pool** (**diusulkan**) | Pengetahuan tentang provider tetap di package provider. Core hanya menyediakan mekanisme. Router tidak berubah. Cakupan per plan cukup diatur dengan menambah atau mengurangi entri translasi. |

---

## 5. Prinsip yang Dijaga

Proposal ini sengaja dirancang agar tidak mengubah jaminan yang sudah ada:

1. **Router, pre-flight, grouping, dan server tidak berubah.** Jika di kemudian hari ternyata ada yang perlu diubah di sana, itu tanda desain ini perlu ditinjau ulang, bukan ditambal.
2. **Arah dependensi tetap satu arah.** Core tidak mengenal package provider mana pun.
3. **Semantik kuota tetap:** potong sebelum request dikirim, tanpa refund, dan berhenti total pada hasil yang ambigu.
4. **Error provider tidak di-retry dan tidak diubah.**
5. **Token apikey tidak pernah dicatat ke log.**

---

## 6. Dampak

| Pihak | Dampak |
|---|---|
| **Client** | Mendapat namespace baru yang stabil. Method provider yang lama tetap bisa dipakai. Tidak ada breaking change. |
| **Operator** | Cakupan method kanonik mengikuti plan apikey yang dikonfigurasi. Tidak ada konfigurasi baru yang wajib. |
| **Pengembang package provider** | Dapat menambahkan dukungan method kanonik secara opsional dengan mendeklarasikan translasi. |
| **Core** | Bertambah satu modul kontrak dan sejumlah perubahan terlokalisasi di pool engine. |
| **Router dan server** | Tidak ada perubahan. |

---

## 7. Risiko

| Risiko | Mitigasi |
|---|---|
| Fungsi pemetaan di package provider punya bug | Kegagalan pemetaan dijawab sebagai error final untuk item terkait, dicatat tanpa token, dan tidak diulang ke provider lain. |
| Biaya terhitung dengan tarif yang salah | Cost selalu dihitung dari nama method asli provider. Ini diverifikasi dengan pengujian. |
| Perubahan capability mengganggu failover | Mekanisme regroup yang ada dipakai tanpa modifikasi, dan diuji secara eksplisit. |
| Format kanonik tidak cocok untuk provider berikutnya | Skema dirancang dari kebutuhan client, bukan dari bentuk respons satu provider. Proposal integrasi pertama menjadi validasinya. |
| Translasi REST terpanggil sebelum didukung | Tidak diiklankan sebagai capability. Jika tetap terpanggil, dijawab sebagai error tanpa mengirim request. |

---

## 8. Validasi

Proposal dianggap berhasil jika:

- Method kanonik di-route ke provider yang mendukungnya, dan ditolak dengan `-32601` jika tidak ada.
- Batch campuran (method standar, method kanonik, dan method provider mentah) tetap mengembalikan hasil sesuai urutan aslinya.
- Parameter tidak valid menghasilkan error per item tanpa memengaruhi item lain.
- Cost yang dipotong sama dengan tarif method asli provider.
- Failover karena batas plan tetap berjalan.
- Seluruh test yang sudah ada tetap lulus, dan tidak ada perubahan pada package di luar `upstream-core`.

Pengujian dilakukan tanpa akses jaringan, dengan fetch, waktu, dan random diinjeksi, mengikuti pola test package provider yang sudah ada.

---

## 9. Pertanyaan Terbuka

1. **Penamaan method kanonik.** Apakah mengikuti pola `kiseki_<kata kerja><Objek>` (mis. `kiseki_getTokenTransfers`) sudah cukup, atau perlu pengelompokan per domain (mis. `kiseki_token_getTransfers`)?
2. **Versi skema.** Bagaimana menangani perubahan bentuk kanonik di masa depan tanpa merusak client: versi di nama method, atau aturan *additive-only*?
3. **Transport REST.** Apakah dukungan `http` cukup diusulkan saat provider REST pertama dibutuhkan, atau perlu dirancang lebih awal?

---

## 10. Langkah Berikutnya

1. Review dan persetujuan kontrak serta lokasi translasi (proposal ini).
2. Implementasi kontrak dan perubahan pool engine di `upstream-core`.
3. Proposal lanjutan: **Integrasi Ankr Advanced API**, yang mendefinisikan set method kanonik pertama sekaligus tabel translasi Ankr.
