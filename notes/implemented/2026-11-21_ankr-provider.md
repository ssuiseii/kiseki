# Provider Ankr Advanced API (`upstream-ankr`)

| | |
|---|---|
| **Jenis** | Proposal desain |
| **Status** | Diajukan untuk review |
| **Tanggal** | 22 November 2026 |
| **Komponen** | `upstream-ankr` (baru), `upstream-core` (perubahan kontrak kecil), registry provider, konfigurasi |
| **Prasyarat** | Proposal *Namespace Kanonik `kiseki_*`* |

---

## Ringkasan

Proposal *Namespace Kanonik `kiseki_*`* menetapkan kontrak translasi, tetapi belum ada provider yang memakainya. Proposal ini mengusulkan **Ankr sebagai provider pertama**, lewat package baru `upstream-ankr` yang melayani enam method kanonik dari Ankr Advanced API (AAPI).

Integrasi ini menemukan tiga hal yang tidak terlihat di atas kertas, dan ketiganya membentuk desain:

1. **AAPI dan node API Ankr dilayani di endpoint yang berbeda dan saling menolak.** Karena itu, setiap chain membutuhkan dua instance upstream dengan identitas bucket masing-masing.
2. **AAPI menerima `params` sebagai objek bernama, bukan array posisional.** Kontrak translasi perlu dilonggarkan agar sisi upstream boleh berbentuk bebas.
3. **Hasil kanonik wajib memuat `chain`, padahal respons Ankr sering tidak menyertakannya.** Fungsi pemetaan respons perlu menerima nama chain.

Yang diminta dari reviewer adalah persetujuan atas: topologi dua instance per chain, dua perubahan aditif pada kontrak `MethodTranslation`, set enam method kanonik pertama, dan kebijakan cost serta validasi untuk Ankr.

---

## 1. Masalah

### 1.1 Namespace kanonik belum punya penyedia

Tanpa provider yang mendeklarasikan translasi, `kiseki_*` belum bisa dipakai client. Provider pertama sekaligus menjadi validasi apakah kontrak dan skema kanonik memang cocok dengan API nyata.

### 1.2 Ankr diperlakukan sebagai provider generik

Saat ini Ankr hanya dilayani lewat fallback generik. Akibatnya:

- **Cost tidak akurat.** Satu panggilan AAPI bernilai 700 API Credits, tetapi dihitung sama dengan `eth_call`.
- **Error tidak diklasifikasi.** Method yang dinonaktifkan untuk plan tertentu tidak memicu regroup ke provider lain.
- **Nama chain tidak diterjemahkan.** AAPI memakai alias sendiri (mis. `eth`, bukan `ethereum`).

### 1.3 Biaya kegagalan tinggi

Setiap panggilan AAPI yang gagal karena parameter tidak sesuai batas provider tetap memotong 700 credit. Validasi yang longgar langsung berdampak pada kuota.

---

## 2. Tujuan

1. Menyediakan **enam method kanonik pertama** melalui Ankr.
2. **Cost mencerminkan tarif Ankr yang sebenarnya.**
3. Method yang dinonaktifkan pada plan tertentu **dialihkan ke provider lain** lewat mekanisme regroup yang sudah ada.
4. Request ke Ankr **mengikuti bentuk yang didokumentasikan**, bukan sekadar bentuk yang kebetulan diterima server.
5. Request yang pasti ditolak provider **dicegat sebelum dikirim**, sehingga tidak ada credit yang terbuang.

### Bukan tujuan

- Mengubah provider lain, termasuk Alchemy.
- Membuat alias kanonik untuk 11 method AAPI lainnya. Method tersebut tetap bisa dipanggil dengan nama aslinya (`ankr_*`).
- Mendukung namespace `stellar_*` milik Ankr.
- Mengubah router, pre-flight, grouping, regroup, atau logika cost di core.

---

## 3. Fakta tentang Ankr

Fakta berikut diambil dari dokumentasi resmi Ankr dan dikonfirmasi dengan probe langsung ke endpoint pada 21–22 November 2026.

### 3.1 Endpoint

| Endpoint | Melayani | Menolak |
|---|---|---|
| `https://rpc.ankr.com/multichain/{apikey}` | Seluruh AAPI (`ankr_*`) | Method node (`eth_*`) |
| `https://rpc.ankr.com/<chain>/{apikey}` | Method node (`eth_*`) | Seluruh AAPI (`ankr_*`) |

### 3.2 Method AAPI

Ada 17 method dengan prefix `ankr_`:

| Kelompok | Method |
|---|---|
| NFT | `getNFTsByOwner`, `getNFTMetadata`, `getNFTHolders`, `getNftTransfers` |
| Query | `getBlockchainStats`, `getBlocks`, `getLogs`, `getTransactionsByHash`, `getTransactionsByAddress`, `getInteractions` |
| Token | `getAccountBalance`, `getCurrencies`, `getTokenPrice`, `getTokenHolders`, `getTokenHoldersCount`, `getTokenTransfers`, `getTokenPriceHistory` |

### 3.3 Tarif

Seluruh method AAPI dikenai tarif seragam **700 API Credits per request** (PAYG: 0,10 USD = 1 juta credit). Method node standar tidak disebut berbayar khusus.

### 3.4 Bentuk request

- `params` didokumentasikan sebagai **objek** bernama (`{ "blockchain": "eth", "address": "0x…" }`). Server saat ini juga menerima array berisi objek, tetapi itu perilaku toleransi, bukan kontrak.
- Parameter `blockchain` memakai **alias Ankr**: `arbitrum`, `avalanche`, `base`, `bsc`, `eth`, `fantom`, `flare`, `gnosis`, `linea`, `optimism`, `polygon`, `scroll`, `somnia_mainnet`, `taiko`, `telos`, `xlayer`, serta testnet `avalanche_fuji`, `base_sepolia`, `eth_sepolia`, `optimism_sepolia`, `polygon_amoy`.
- `tokenId` harus dikirim sebagai **string**. Dokumentasi menyebut integer, tetapi endpoint menolak angka dengan `-32602`.
- `ankr_getNFTsByOwner` membatasi `pageSize` **maksimal 50**. Method lain jauh di atas batas kanonik.

### 3.5 Bentuk respons

- Field `value` pada transfer token **terbukti bisa salah hingga 10×**. Nilai yang benar harus diturunkan dari `valueRawInteger`.
- Respons sering tidak memuat nama chain. Halaman kosong tidak memuat data apa pun.

### 3.6 Error yang teramati

| Kode | Arti |
|---|---|
| `-32601` | Method tidak ditemukan |
| `-32075` | Method dinonaktifkan (batas plan) |
| `-32602` | Parameter tidak valid |
| `-32090` | Rate limit |
| `-32000`, `-32052` | Autentikasi |

Pesan khusus berisi ajakan "upgrade plan" **tidak teramati**, sehingga tidak ada pola tebakan yang dipakai.

---

## 4. Usulan

### 4.1 Topologi: dua instance per chain

```
                        ┌─ ankr-<chain>-aapi ─▶ /multichain/{apikey}
Router ─ chain X ───────┤   provider: ankr-aapi   methods: ankr_*
                        │   (+ kiseki_* otomatis dari tabel translasi)
                        │
                        └─ ankr-<chain>-node ─▶ /<chain>/{apikey}
                            provider: ankr-node   methods: eth_*
```

- Masing-masing endpoint hanya melayani salah satu jenis method, jadi satu instance tidak bisa mencakup keduanya.
- Kedua instance memakai **identitas provider berbeda** (`ankr-aapi` dan `ankr-node`). Identitas provider menentukan bucket kuota. Jika keduanya berbagi identitas tetapi jumlah bucket-nya berbeda, bucket akan dibangun ulang dan pemakaian credit yang sudah tercatat hilang tanpa peringatan.

Contoh konfigurasi:

```yaml
chains:
  ethereum:
    upstreams:
      - name: ankr-ethereum-aapi
        provider: ankr-aapi
        package: ankr
        url_template: "https://rpc.ankr.com/multichain/{apikey}"
        apikeys:
          - token: "${ANKR_KEY}"
            label: main
            buckets:
              - { capacity: 100000, refill_per_second: 50 }  # API Credits
        methods: ["ankr_*"]   # kiseki_* dicover otomatis dari tabel translasi

      - name: ankr-ethereum-node
        provider: ankr-node
        package: ankr
        url_template: "https://rpc.ankr.com/eth/{apikey}"
        apikeys:
          - token: "${ANKR_KEY}"
            label: main
            buckets:
              - { capacity: 15,  refill_per_second: 15 }   # RPS
              - { capacity: 600, refill_per_second: 10 }   # RPM
        methods: ["eth_*"]
```

Angka bucket di atas hanya ilustrasi. Operator menyesuaikannya dengan plan masing-masing.

### 4.2 Method kanonik

| Method kanonik | Method Ankr | Pemetaan utama |
|---|---|---|
| `kiseki_getTokenTransfers` | `ankr_getTokenTransfers` | Filter kontrak, rentang blok, paging ke `nextPage` |
| `kiseki_getTransactionsByAddress` | `ankr_getTransactionsByAddress` | Urutan dan paging dinormalisasi |
| `kiseki_getAccountBalance` | `ankr_getAccountBalance` | Dibatasi pada chain instance; native dan ERC-20 |
| `kiseki_getNFTsByOwner` | `ankr_getNFTsByOwner` | Owner dan filter kontrak; metadata mentah tidak disertakan |
| `kiseki_getNFTMetadata` | `ankr_getNFTMetadata` | `chain`, `contract`, `tokenId`, `name?`, `image?`, `collection?` |
| `kiseki_getTokenPrice` | `ankr_getTokenPrice` | `chain`, `contract`, `priceUsd`, `updatedAt` |

Keenam method ini dipilih karena merupakan kebutuhan paling umum client (riwayat, saldo, NFT, harga), dan konsepnya tersedia di provider enhanced API lain. Dengan begitu, skema kanonik tidak terlalu mengikuti bentuk Ankr saja.

### 4.3 Perilaku package

| Aspek | Perilaku |
|---|---|
| **Bentuk request** | `params` dikirim sebagai objek sesuai dokumentasi. `blockchain` dikirim sebagai string satu chain (mis. `"eth"`), karena setiap instance hanya melayani satu chain. |
| **Alias chain** | Nama chain kiseki diterjemahkan ke alias Ankr dari tabel tetap di package. Chain tanpa alias dianggap parameter tidak valid, **tidak ditebak**. |
| **Batas `pageSize` NFT** | `pageSize` di atas 50 pada `kiseki_getNFTsByOwner` ditolak sebagai parameter tidak valid **sebelum request dikirim**. Nilainya tidak dipotong diam-diam, karena itu akan mengubah maksud request client. |
| **Normalisasi respons** | Nilai token diturunkan dari `valueRawInteger` dan dikembalikan sebagai string desimal beserta nilai mentahnya. Nama chain diisi dengan nama kiseki. Field yang tidak dikenal dibuang. |
| **Klasifikasi error** | `-32601` dan `-32075` dianggap "method tidak didukung" sehingga memicu regroup. Error lainnya, termasuk `execution reverted` dan `-32602`, diteruskan apa adanya. Prinsipnya **konservatif**: jika ragu, error tidak diklasifikasi. |
| **Method mentah** | `ankr_*` tetap bisa dipanggil langsung oleh client. Namespace kanonik hanya lapisan alias. |

### 4.4 Cost

```ts
export const ANKR_COSTS: CostTable = {
  "ankr_get*": 700,   // seluruh AAPI, tarif seragam
  // eth_* tidak diisi → memakai lapisan global / 1
}
```

- Pola `ankr_get*` sengaja dipilih, bukan `ankr_*`. Jika Ankr kelak menambah method non-`get` dengan tarif lain, method tersebut tidak otomatis terkunci di 700.
- Cost item kanonik otomatis dihitung dengan nama method Ankr, seperti dijamin proposal *Namespace Kanonik*.
- Operator tetap bisa mengganti tarif per instance lewat konfigurasi.

### 4.5 Perubahan kontrak di core

Integrasi ini membutuhkan dua perubahan pada kontrak `MethodTranslation`. Keduanya **aditif**: implementasi yang sudah ada tetap sah tanpa diubah.

| Perubahan | Sebelum | Sesudah | Alasan |
|---|---|---|---|
| Hasil `mapRequest` | `unknown[] \| undefined` | `unknown \| undefined` | JSON-RPC 2.0 mengizinkan `params` berupa array maupun objek, dan tipe JSON-RPC di core sudah mengakuinya. Bentuk sisi upstream menjadi urusan provider. Sisi kanonik tetap array dari client. |
| Argumen `mapResponse` | `(result, params)` | `(result, params, chain)` | Skema kanonik mewajibkan `chain` di hasil, sedangkan respons provider sering tidak memuatnya. |

Pool engine sudah meneruskan `params` ke body request apa adanya, jadi perubahan pertama hanya pelebaran tipe. Router, regroup, dan perhitungan cost tidak tersentuh.

---

## 5. Alternatif yang Dipertimbangkan

| Alternatif | Alasan tidak dipilih |
|---|---|
| **Satu instance di endpoint per-chain** | Endpoint per-chain menolak seluruh AAPI. |
| **Satu instance di endpoint multichain** | Endpoint multichain menolak seluruh method node. |
| **Dua instance dengan identitas provider yang sama** | Bucket dibangun ulang saat jumlahnya berbeda, sehingga pemakaian credit hilang tanpa peringatan. |
| **Tetap mengirim `params` sebagai array** | Berjalan hari ini hanya karena toleransi server, dan bisa berhenti kapan saja. Kepatuhan pada dokumentasi lebih penting daripada toleransi. |
| **Memotong `pageSize` NFT ke 50 secara diam-diam** | Mengubah makna request client tanpa sepengetahuannya. |
| **Membiarkan Ankr menolak `pageSize` yang terlalu besar** | Setiap penolakan tetap memotong 700 credit. |
| **Mengisi `chain` di hasil tanpa mengubah kontrak** (mis. menyimpannya di closure) | Pemetaan respons jadi tidak murni dan rawan salah pada batch campuran. Menambah argumen lebih eksplisit dan aman. |
| **Memakai field `value` dari Ankr** | Terbukti bisa salah hingga 10×. |

---

## 6. Prinsip yang Dijaga

1. **Router, pre-flight, grouping, dan server tidak berubah.** Satu-satunya perubahan di luar package Ankr adalah pendaftaran package di registry provider, serta dua perubahan kontrak aditif di §4.5.
2. **Arah dependensi tetap satu arah.** Package Ankr hanya bergantung pada `upstream-core`.
3. **Semantik kuota tetap:** potong sebelum request dikirim, tanpa refund.
4. **Parameter tidak valid adalah error final**, tanpa request ke provider dan tanpa regroup.
5. **Error provider tidak diubah dan tidak di-retry.**
6. **Token apikey tidak pernah dicatat ke log.**
7. **Translasi tidak ditulis dari ingatan.** Setiap bentuk parameter dan respons diverifikasi ke dokumentasi dan endpoint nyata.

---

## 7. Dampak

| Pihak | Dampak |
|---|---|
| **Client** | Enam method `kiseki_*` mulai tersedia. Method `ankr_*` dan `eth_*` tetap berjalan seperti biasa. Tidak ada breaking change. |
| **Operator** | Instance Ankr perlu dipecah menjadi dua per chain. Disarankan memakai bucket credit terpisah untuk AAPI. |
| **Package provider lain** | Tidak terdampak. Perubahan kontrak bersifat aditif. |
| **Core** | Dua perubahan tipe pada kontrak translasi. Tidak ada perubahan perilaku. |
| **Dokumentasi** | Panduan pembuatan package provider perlu menjelaskan bahwa bentuk `params` upstream bebas, serta cara menambah method kanonik. README perlu memuat cara pakai namespace dan peringatan skala cost AAPI. |

---

## 8. Risiko

| Risiko | Mitigasi |
|---|---|
| **Satu panggilan AAPI menguras bucket kecil.** Dengan bucket 15 RPS, satu panggilan AAPI menghabiskan kuota ~47× lebih cepat daripada `eth_call`. | Peringatan di dokumentasi dan contoh konfigurasi. Rekomendasi bucket credit terpisah. Tarif dapat diganti per instance. |
| **Ankr berhenti menerima `params` objek** | Bentuk objek adalah kontrak resmi. Verifikasi ke endpoint nyata dilakukan sebelum rilis. Jika ditolak, rilis dihentikan dan dilaporkan, tanpa menambah fallback array diam-diam. |
| **Pesan atau kode error Ankr berubah** | Klasifikasi konservatif. Kode yang tidak dikenal diteruskan apa adanya, bukan memicu regroup. |
| **Ketersediaan AAPI berubah per plan** | `-32075` memicu regroup. Cakupan cukup diatur dari tabel translasi package. |
| **Dokumentasi Ankr tidak akurat** (contoh: `tokenId`, field `value`) | Setiap bentuk dikonfirmasi ke endpoint nyata. Test memakai fixture dari respons nyata. |
| **Perubahan kontrak memecah pemakai lama** | Kedua perubahan bersifat pelebaran. Test yang ada tetap memakai bentuk lama dan berfungsi sebagai penjaga kompatibilitas. |

---

## 9. Validasi

Proposal dianggap berhasil jika:

- **Cost:** method kanonik dan `ankr_*` dipotong 700, `eth_call` dipotong 1, dan tarif dari konfigurasi instance menang.
- **Capability:** instance AAPI mencakup `kiseki_*`. Instance tanpa translasi menolaknya dengan `-32601`.
- **Request:** body yang dikirim memakai `params` **objek** dengan alias chain yang benar (mis. `ethereum` → `eth`).
- **Respons:** hasil Ankr dinormalisasi ke skema kanonik, termasuk nilai desimal, `nextPage`, dan nama chain kiseki.
- **Validasi lokal:** parameter tidak valid, chain tanpa alias, dan `pageSize` NFT di atas 50 menghasilkan error final **tanpa request dan tanpa credit terpotong**. Batas 50 sendiri lolos.
- **Klasifikasi error:** `-32601` dan `-32075` memicu regroup. `execution reverted`, `-32602`, rate limit, dan error autentikasi diteruskan apa adanya.
- **Batch campuran:** `eth_*`, `kiseki_*`, dan `ankr_*` dalam satu request diterjemahkan per item dengan urutan hasil terjaga.
- **Kompatibilitas:** translasi yang masih mengembalikan array tetap dikirim sebagai array.
- **Uji lapangan:** keenam method kanonik berhasil terhadap endpoint Ankr nyata dengan `params` objek.

Test unit berjalan tanpa jaringan, dengan fetch, waktu, dan random diinjeksi. Uji lapangan memakai apikey nyata dan dilakukan terpisah sebelum rilis.

---

## 10. Batasan yang Diterima

**Pesan error `pageSize` belum menyebut batasnya.** Client yang mengirim `pageSize: 60` ke `kiseki_getNFTsByOwner` hanya menerima `-32602 "invalid params"`, tanpa keterangan bahwa batasnya 50. Kontrak saat ini membuat `mapRequest` hanya bisa mengembalikan `undefined` untuk menandai parameter tidak valid. Menyertakan detail error membutuhkan perubahan kontrak yang lebih besar, dan hal itu sebaiknya diajukan sebagai proposal terpisah.

---

## 11. Pertanyaan Terbuka

1. **Alias chain per instance.** Apakah operator perlu bisa mengganti alias chain lewat konfigurasi (mis. `chain_aliases:`), atau tabel tetap di package sudah cukup?
2. **Error terstruktur dari `mapRequest`.** Apakah batasan di §10 perlu segera diselesaikan, misalnya dengan membiarkan `mapRequest` mengembalikan error beserta detailnya?
3. **Alias untuk 11 method AAPI lainnya.** Apakah method ini sebaiknya dijadikan kanonik saat provider kedua tersedia, atau ditentukan berdasarkan permintaan client?
4. **Bucket credit default.** Apakah contoh konfigurasi resmi sebaiknya langsung memisahkan bucket credit untuk AAPI, supaya operator tidak terjebak memakai bucket RPS?

---

## 12. Langkah Berikutnya

1. Review dan persetujuan proposal ini.
2. Perubahan kontrak aditif di `upstream-core` (§4.5), dirilis terpisah dari package Ankr.
3. Package `upstream-ankr` beserta pendaftarannya di registry provider.
4. Pembaruan contoh konfigurasi dan dokumentasi.
5. Uji lapangan terhadap endpoint Ankr nyata sebelum rilis.
