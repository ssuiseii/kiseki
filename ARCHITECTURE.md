# Arsitektur Kiseki

> Dokumen ini menjelaskan arsitektur **kode yang sudah berjalan** di repositori
> ini, bukan rencana. Isinya adalah perilaku yang dapat diverifikasi dari
> `packages/kiseki` dan `packages/upstream-core`.
>
> Ruang lingkup: paket `kiseki` (permukaan HTTP, pipeline, router, observability)
> dan paket `upstream-core` (kontrak adapter, model kuota, pool apikey). Detail
> implementasi adapter per provider berada di luar cakupan dokumen ini; yang
> dibahas hanyalah batas kontraknya, di §3.5.

---

## Daftar Isi

1. [Ringkasan](#1-ringkasan)
2. [Gambaran sistem](#2-gambaran-sistem)
3. [Komponen](#3-komponen)
4. [Alur data](#4-alur-data)
5. [Model kuota dan cost](#5-model-kuota-dan-cost)
6. [Penanganan error](#6-penanganan-error)
7. [Konfigurasi](#7-konfigurasi)
8. [Invarian](#8-invarian)
9. [Keputusan desain](#9-keputusan-desain)
10. [Batasan yang diketahui](#10-batasan-yang-diketahui)
11. [Yang belum berfungsi](#11-yang-belum-berfungsi)
12. [Glosarium](#12-glosarium)

---

## 1. Ringkasan

Kiseki adalah proxy JSON-RPC untuk chain EVM. Klien mengirim request JSON-RPC 2.0
ke satu endpoint; Kiseki memutuskan upstream mana yang melayani tiap item, memilih
apikey di dalam upstream tersebut, lalu mengembalikan jawaban dalam bentuk yang
sama seperti yang dikirim klien.

Masalah yang diselesaikannya: klien tidak lagi terikat pada satu provider. Kuota
per apikey dimodelkan sebagai bucket, kapabilitas tiap upstream dicatat sebagai
konfigurasi, dan request yang tidak bisa dilayani satu upstream dipindahkan ke
upstream lain di dalam request yang sama. Klien melihat satu endpoint, satu
request, dan satu jawaban — tanpa perlu tahu provider mana yang menjawab, plan apa
yang aktif, atau key mana yang terpakai.

---

## 2. Gambaran sistem

### 2.1 Jalur request

Routing berlangsung **dua level**. Level 1 (router, di paket `kiseki`) memilih
instance upstream. Level 2 (`ApikeyPool`, di paket `upstream-core`) memilih apikey
di dalam instance tersebut dan menangani failover antar-key.

```
Client
  |  POST /{chain}/{key?}    JSON-RPC 2.0: satu objek atau array
  v
+----------------------------- kiseki -----------------------------+
|  auth -> chain -> parse                                          |
|    |                                                             |
|    +- A. klasifikasi + pre-flight   kelas metode, kebutuhan      |
|    |                                arsip, idempotensi, blokir   |
|    +- B. grouping                   kunci grup                   |
|    +- C. routing level 1            pilih instance (berbobot)    |
|    |        |                                                    |
|    |        +--> upstream-core: ApikeyPool  (level 2)            |
|    |                 pilih apikey -> potong kuota -> HTTP        |
|    +- D. merge + shaping            urutan asli, status 200/429  |
+------------------------------------------------------------------+
                              |
                              v
                    provider RPC (upstream)
```

Router tidak pernah melihat apikey, dan pool tidak pernah melihat instance lain.
Keduanya hanya bertemu pada satu kontrak: `UpstreamOutcome` (§3.4).

### 2.2 Properti inti

Enam properti berikut menentukan hampir seluruh keputusan desain, dan masing-masing
punya bagian rinci:

1. **Routing dua level.** Level 1 memilih instance berdasarkan kapasitas bebas;
   level 2 memilih apikey dan menangani failover antar-key. Router tidak pernah
   melihat apikey (§4.4, §5.4).
2. **Kuota sebagai token bucket.** Setiap apikey memiliki satu atau lebih bucket
   dengan refill kontinu dan lazy. Biaya dipotong sebelum request dikirim dan
   tidak pernah dikembalikan (§5.1, §5.3).
3. **Kapabilitas statis, dikoreksi saat runtime.** Kandidat ditentukan dari
   konfigurasi sebelum request dikirim. Jika provider ternyata menolak, item
   dipindahkan ke upstream lain pada request yang sama, dan hasilnya dicatat agar
   request berikutnya tidak mengulang kesalahan yang sama (§4.2, §6.2).
4. **Fail fast.** Tidak ada antrean. Ketika seluruh kandidat kehabisan kapasitas,
   klien menerima `429` dengan estimasi `Retry-After` yang masuk akal (§4.6, §6.4).
5. **Send-safe.** `eth_sendRawTransaction` yang hasilnya ambigu menghentikan
   seluruh failover, sehingga tidak pernah ada klaim sukses dari upstream lain
   untuk transaksi yang mungkin sudah masuk mempool (§5.5, §6.1).
6. **Satu namespace kanonik.** Metode non-standar provider diterjemahkan ke
   namespace `kiseki_*` yang netral terhadap provider, dengan skema parameter dan
   hasil yang sama untuk semua upstream (§4.8).

---

## 3. Komponen

### 3.1 Tabel paket

| Paket | Peran | Tanggung jawab | Yang tidak boleh dilakukan |
|---|---|---|---|
| `packages/kiseki` | Proses, HTTP, orkestrasi | config, classify, capability, batch, router, pipeline, server, observability, reload | Tidak boleh memuat logika pemilihan apikey, pemotongan kuota, atau parsing error provider |
| `packages/upstream-core` | Kontrak dan mesin | tipe JSON-RPC, taksonomi outcome, `ApikeyPool`, `BucketRegistry`, cost table, transport HTTP, signature kapabilitas, namespace kanonik | Tidak boleh mengimpor apa pun dari `packages/kiseki`; tidak boleh mengetahui HTTP server, konfigurasi, atau observability |
| `packages/upstream-<provider>` | Adapter tipis per provider | tabel cost default, signature error khas provider, header wajib, tabel translasi `kiseki_*` | Tidak boleh memuat logika routing, pemilihan apikey, cooldown, atau klasifikasi HTTP |

Paket provider (`upstream-generic`, `upstream-alchemy`, `upstream-ankr`) berada di
luar cakupan dokumen ini. Yang perlu diketahui dari sisi arsitektur hanyalah
kontraknya, dan kontrak itu dijelaskan di §3.5.

`upstream-core` mengekspor permukaan publiknya hanya melalui
`packages/upstream-core/src/index.ts`. Helper internal yang tidak diekspor di sana
bebas berubah tanpa memutus kontrak.

### 3.2 Arah dependensi dan composition root

Arah dependensi bersifat satu arah, dengan satu pengecualian yang disengaja:

```
packages/kiseki  ──▶  upstream-core
packages/upstream-<provider>  ──▶  upstream-core
packages/kiseki/src/registry.ts  ──▶  upstream-core + semua paket provider
```

`packages/kiseki/src/registry.ts` adalah satu-satunya titik ekstensi, dan
satu-satunya berkas di paket `kiseki` yang boleh mengimpor paket provider. Berkas
itu tidak mengandung logika: ia memetakan nilai `package:` pada konfigurasi ke
implementasi adapter yang sesuai.

Router, server, classifier, dan pipeline bekerja sepenuhnya terhadap abstraksi
`UpstreamAdapter`, sehingga perubahan pada implementasi adapter tidak menyentuh
lapisan routing. Nilai `package:` yang tidak terdaftar ditolak saat startup, bukan
di-fallback diam-diam.

### 3.3 Batas proses

Tiga modul membentuk batas proses, dan pembagiannya disengaja:

| Modul | Tanggung jawab |
|---|---|
| `cli.ts` | Entry module untuk binary hasil kompilasi. Selalu berjalan saat dieksekusi. |
| `main.ts` | Parsing argumen, satu panggilan `start()`, handler sinyal, kebijakan exit code. |
| `index.ts` | Permukaan library. Tanpa efek samping proses, sehingga aman diimpor dari test. |

Pemisahan `cli.ts` dan `index.ts` bukan kosmetik. `bun build --compile` hanya
menjalankan modul yang ditunjuk sebagai entry, dan `import.meta.main` bernilai
`true` hanya di modul tersebut. Binary yang dibangun dari `index.ts` akan keluar
dengan kode 0 tanpa pernah membuka socket — kegagalan yang senyap. Karena itu build
diarahkan ke `cli.ts`, yang memanggil `runCli()` tanpa syarat.

`start()` adalah fungsi yang sama yang dipakai binary dan test, sehingga seluruh
jalur startup dapat diuji tanpa child process:

1. Muat konfigurasi sekali untuk mengetahui daftar secret.
2. Bangun logger (secret didaftarkan untuk scrubbing) dan objek metrics.
3. Bangun runtime: `BucketRegistry`, `RuntimeNotes`, adapter per instance, dan
   view per chain.
4. Bangun server Hono dan panggil `Bun.serve`.

Urutan 2 dan 3 tidak dapat ditukar. Adapter melaporkan event ke observer, dan
observer adalah objek metrics; metrics harus ada lebih dulu. Sebaliknya, metrics
membaca bucket hidup yang baru dibuat oleh runtime, sehingga collector-nya menerima
thunk, bukan objek. Holder `current.runtime` memutus siklus ini sekaligus membuat
reload transparan terhadap `/metrics`.

Sinyal yang ditangani: `SIGHUP` memicu reload, `SIGINT` dan `SIGTERM` menutup
server lalu keluar.

### 3.4 Kontrak antar lapisan

Lima tipe menyeberangi batas modul. `Group`, `GroupItem`, `UpstreamOutcome`, dan
`Entry` didefinisikan di `upstream-core`; `RequestItem` milik lapisan `batch` di
paket `kiseki`.

| Tipe | Arah | Peran |
|---|---|---|
| `RequestItem` | parse → pipeline | Satu item JSON-RPC beserta `originalIndex`, `id`, `method`, `params` |
| `Group` / `GroupItem` | router → adapter | Sekumpulan item yang berbagi tujuan, plus `needsArchive`, `idempotency`, `timeoutMs` |
| `UpstreamOutcome` | adapter → router | Taksonomi hasil: `success`, `domain_error`, `unsupported`, `rate_limited`, `sick`, `ambiguous` |
| `Entry` | adapter → router | Satu jawaban per item: `ok` dengan `result`, atau `error` dengan flag `final` |

Router bereaksi terhadap `kind`, tidak pernah terhadap error mentah provider. Itu
sebabnya taksonomi ini adalah satu-satunya hal yang perlu disepakati antara lapisan
routing dan lapisan eksekusi.

`GroupItem.historical` dibawa secara internal untuk memperlebar signature
capability mismatch: pesan "block not found" hanya dianggap bukti tidak adanya state
arsip ketika query-nya memang historis.

### 3.5 Titik ekstensi: menambah upstream baru

Semua yang dibutuhkan untuk menambah provider bermuara pada satu ekspor wajib di
paket provider:

```ts
type AdapterFactory = (cfg: UpstreamInstanceConfig, deps: CoreDeps) => UpstreamAdapter
```

Router hanya melihat empat anggota `UpstreamAdapter`: `capability()`, `weight()`,
`earliestReadyAt()`, dan `attempt()` → `UpstreamOutcome`. Nama paket provider tidak
pernah muncul di router, server, classifier, atau pipeline.

Hampir seluruh kebutuhan ditutup oleh `createPoolAdapter(cfg, deps, hooks)`.
`AdapterHooks` (didefinisikan di `packages/upstream-core/src/pool.ts`) hanya berisi
kekhasan provider: tabel cost default, signature error, header tambahan, akuntansi
batch, dan tabel translasi `kiseki_*`. Referensi lengkap setiap hook dan langkah
membuat paket provider ada di `docs/upstream-package-guide.md`.

Pembagian tanggung jawabnya tegas, dan bagian yang sudah dijamin engine tidak boleh
diduplikasi di paket provider:

| Perilaku | Dikerjakan oleh |
|---|---|
| Pemilihan apikey dan weighted-random | `ApikeyPool` |
| Pemotongan kuota sinkron sebelum fetch, tanpa refund | `ApikeyPool` |
| Cooldown dan kesehatan per key maupun per provider | `ApikeyPool` |
| Klasifikasi HTTP 429 / 5xx / timeout / body rusak | `classifyResponse`, `classifyBody` |
| URL dari `{apikey}` | otomatis dari `cfg.url_template` |
| Timeout | `cfg.timeout_ms` atau timeout kelas metode (§4.2) |
| Iklan cakupan `kiseki_*` | diturunkan dari `methods:` dan tabel translasi (§4.8) |
| Perhitungan cost item kanonik memakai nama metode upstream | `itemCost` di pool |
| Error provider diteruskan apa adanya | engine, tanpa perubahan |

### 3.6 Autentikasi

`packages/kiseki/src/server/auth.ts` menyediakan dua kanal yang divalidasi terhadap
satu allowlist:

| Kanal | Bentuk | Untuk |
|---|---|---|
| path-key | `POST /{chain}/{key}` | tooling gaya forge, cast, ethers |
| Bearer | `POST /{chain}` + header | aplikasi server yang bisa menyetel header |

Parameter query sengaja tidak didukung. `?apikey=` ditolak, bukan diabaikan,
karena mengabaikannya akan membuat klien mengira sudah terautentikasi padahal
belum.

Dua properti yang menjadi tanggung jawab modul ini:

1. **Urutan.** Autentikasi diputuskan sebelum chain diresolusi, sehingga chain yang
   tidak dikenal dengan kredensial salah dijawab `401`, bukan `404`. Urutan inilah
   yang mencegah proxy menjadi oracle bagi daftar chain yang ada.
2. **Tidak ada rahasia yang keluar.** Hasil autentikasi hanya membawa label. Token
   dibandingkan dalam bentuk digest SHA-256, sehingga perbandingan tidak
   membocorkan panjang atau prefiks yang cocok melalui timing.

Jika kedua kanal aktif dan keduanya hadir, salah satu yang cocok sudah cukup. Kanal
yang dinonaktifkan pada konfigurasi tidak menerima kredensial meskipun tokennya
valid — kalau tidak, niat operator akan terlewati secara diam-diam.

### 3.7 Observability

**Metrik**

`packages/kiseki/src/observ/metrics.ts` menyatukan dua peran dalam satu objek:
objek metrics **adalah** observer. Tidak ada lapisan adapter terpisah, sehingga
sebuah metrik tidak dapat ada tanpa event yang menggerakkannya.

Prinsip kedua: counter didorong event, gauge ditarik saat scrape. Kredit dan sisa
cooldown adalah besaran yang berubah terhadap waktu; gauge yang di-push akan
membeku pada nilai request terakhir.

| Metrik | Tipe | Label |
|---|---|---|
| `kiseki_requests_total` | counter | chain, method_class, client_label |
| `kiseki_batch_items_total` | counter | chain, client_label |
| `kiseki_upstream_attempts_total` | counter | upstream, outcome |
| `kiseki_pool_key_attempts_total` | counter | upstream, apikey, outcome |
| `kiseki_pool_key_failover_total` | counter | upstream |
| `kiseki_upstream_latency_seconds` | histogram | upstream |
| `kiseki_preflight_rejects_total` | counter | chain, reason |
| `kiseki_capability_regroups_total` | counter | chain, cap |
| `kiseki_failfast_total` | counter | chain, method_class |
| `kiseki_sendraw_ambiguous_total` | counter | upstream |
| `kiseki_apikey_credits` | gauge (pull) | provider, apikey, bucket_index |
| `kiseki_apikey_cooldown_seconds_remaining` | gauge (pull) | provider, apikey |

Label selalu berupa label, tidak pernah token. Identitas yang tidak dikenal
menggunakan hash FNV-1a yang stabil dan tidak dapat dibalik.

Satu request batch yang memuat beberapa kelas metode dihitung sekali per kelas yang
benar-benar ada, bukan diberi satu kelas "batch" yang dibuat-buat.

**Log**

`packages/kiseki/src/observ/logger.ts` menulis satu objek JSON per baris ke stdout,
sehingga `journalctl -o cat | jq` bekerja tanpa perlakuan khusus.

Tiga aturan ditegakkan secara struktural, bukan lewat disiplin review:

1. **Tidak pernah ada rahasia.** Setiap nilai string discrub terhadap daftar secret
   yang didaftarkan saat startup. Pemanggil yang keliru menyisipkan token ke dalam
   pesan akan dinetralkan, bukan dibocorkan.
2. **Tidak pernah ada parameter request.** Tidak ada jalur di sini yang
   menyerialkan body. Parameter hanya dapat dijangkau lewat flag opt-in
   `KISEKI_DEBUG_BODIES=1`, dan nilai yang lewat flag itu pun tetap mengalami
   scrubbing. Flag ini belum tersambung (§11).
3. **Murah saat mati.** Level `debug` dibuang sebelum serialisasi, sehingga jalur
   panas hanya membayar satu perbandingan.

---

## 4. Alur data

### 4.1 Satu request

```
POST /{chain}/{key?}
  │
  ├─ auth          server/auth.ts     path-key atau Bearer → label klien
  ├─ chain         server/index.ts    resolusi chain dari segmen pertama path
  ├─ parse         batch/index.ts     body → item routable + item ditolak
  │
  ├─ A. klasifikasi + pre-flight      classify/ + capability/
  │      kelas metode, kebutuhan arsip, idempotensi, blokir kebijakan
  │      kandidat = kapabilitas statis − catatan runtime
  │
  ├─ B. grouping                      router/planGroups
  │      kunci grup = (himpunan kandidat yang belum dicoba, arsip, idempotensi)
  │
  ├─ C. routing                       router/route
  │      level 1: pilih instance berbobot headroom → adapter.attempt()
  │      level 2: pilih apikey berbobot sisa kredit → potong kuota → HTTP
  │      loop regroup untuk item yang terbukti tidak cocok
  │
  └─ D. merge + shaping               pipeline/
         urutkan berdasarkan indeks asli, bungkus envelope, tentukan 200/429
```

Batas tanggung jawabnya tegas: `pipeline/index.ts` menerima body yang sudah
di-parse dan mengembalikan status serta body, tanpa menyentuh HTTP. `server/` hanya
mengubah `Request` menjadi pemanggilan `handle()` dan hasilnya menjadi `Response`.
Karena itu seluruh alur dapat diuji tanpa socket.

### 4.2 Klasifikasi dan pre-flight

`packages/kiseki/src/classify/index.ts` menjawab empat pertanyaan untuk setiap item:

| Pertanyaan | Dampak |
|---|---|
| Kelas metode | `heavy` memakai timeout panjang (`trace_*`, `debug_*`, `replay_*` secara default) |
| Butuh arsip? | Mempersempit kandidat dan mengaktifkan pre-flight arsip |
| Idempoten? | `eth_sendRawTransaction` satu-satunya metode non-idempoten |
| Diblokir? | Ditolak sebelum routing, tanpa biaya kuota |

Deteksi arsip bekerja dari posisi parameter per metode: daftar metode yang
argumennya adalah nomor blok, daftar metode yang argumennya adalah hash blok, dan
filter log yang memakai `fromBlock`/`blockHash`. Tag `latest`, `pending`, `safe`,
dan `finalized` dianggap non-arsip; `earliest` dan hash blok dianggap arsip; nomor
blok eksplisit dianggap arsip bila lebih tua dari 128 blok dari tip.

Classifier sengaja tidak menebak. Metode yang posisi bloknya tidak dikenal
diklasifikasikan non-arsip, karena salah menandai "arsip" akan membuang seluruh
upstream non-arsip untuk request yang sebenarnya tidak membutuhkannya. Kesalahan ke
arah sebaliknya ditangkap oleh tabel signature di runtime dan diperbaiki lewat
regroup.

Classifier juga tidak menghitung biaya. Biaya baru relevan saat pemilihan key, dan
tabel biaya berlapis per provider; menaruhnya di classifier akan menduplikasi
logika tersebut di tempat yang salah.

Kandidat sebuah item adalah irisan antara kapabilitas statis yang diklaim
konfigurasi dan catatan runtime yang membuktikan sebaliknya.

Kapabilitas statis berupa daftar pola metode (persis atau wildcard di akhir) plus
satu flag arsip. Wildcard di posisi lain adalah kesalahan konfigurasi dan gagal
tertutup: pola seperti itu tidak pernah cocok, sehingga pre-flight menolak alih-alih
mengklaim dukungan untuk segalanya.

Catatan runtime adalah memori proses yang mencatat, per instance, metode mana yang
terbukti tidak tersedia dan apakah instance tersebut terbukti tidak mampu melayani
state historis. Catatan ini:

- tidak bergantung pada apikey — yang terbukti adalah upstream-nya, bukan key-nya;
- membuat request berikutnya melewati upstream tersebut tanpa belajar ulang;
- di-reset saat reload konfigurasi (§7.4);
- tidak pernah dipersistensi.

Kandidat kosong adalah satu-satunya penolakan instan: tidak ada kuota yang dipotong
dan tidak ada percobaan yang dilakukan.

### 4.3 Grouping

Item yang lolos pre-flight dikelompokkan sebelum dikirim. Kunci grup adalah
kombinasi dari:

- himpunan kandidat yang belum dicoba,
- kebutuhan arsip,
- kelas idempotensi.

Memakai himpunan kandidat (bukan kandidat statis) membuat himpunan "sudah dicoba"
seragam di dalam satu grup, sehingga satu loop dapat melayani seluruh item grup
tanpa pernah mengirim item ke upstream yang sudah menjawabnya. `timeoutMs` grup
diambil dari item terlambat, karena satu percobaan punya satu tenggat.

### 4.4 Routing level 1

`packages/kiseki/src/router/index.ts` menjalankan satu grup sampai setiap itemnya
terjawab atau terbukti tidak dapat dilayani.

**Kelayakan dan pemilihan.** Kandidat sebuah item adalah
`kandidat ∧ belum dicoba ∧ bobot > 0`. Status sakit tidak perlu diperiksa terpisah:
adapter yang sedang sakit mengembalikan `sick` tanpa melakukan fetch, yang secara
perilaku identik dengan menyaringnya.

Bobot adalah Σ headroom seluruh apikey pada instance tersebut (§5.2). Pemilihan
dilakukan secara weighted-random atas total bobot, sehingga upstream dengan
kapasitas lebih besar menerima porsi trafik yang lebih besar tanpa menjadi
deterministik.

Router tidak pernah menyentuh bucket. Ia hanya membaca skalar yang dilaporkan
adapter, sehingga model kuota dapat berubah tanpa mengubah router.

**Batas percobaan.** `limits.max_total_attempts` dapat memasang batas jumlah
percobaan per grup; nilai `0` berarti tanpa batas, yang merupakan perilaku default.
Batas ini adalah katup pengaman, bukan mekanisme utama penghentian.

Reaksi terhadap tiap outcome dijelaskan di §6.1.

### 4.5 Loop regroup

Item yang terbukti tidak cocok dengan kapabilitas upstream tidak langsung menjadi
error klien. Item tersebut dikembalikan ke antrean, dikelompokkan ulang tanpa
upstream yang sudah mencobanya, lalu dikirim ke upstream lain pada request yang
sama. Efeknya terlihat oleh klien: satu request, satu jawaban, tanpa retry manual.

Loop ini berhenti karena setiap regroup hanya terjadi untuk item yang baru saja
dicoba oleh sebuah upstream, dan upstream itu ditambahkan ke himpunan `tried` yang
tidak pernah menyusut. Dengan daftar upstream yang berhingga, loop tidak mungkin
berjalan selamanya. Batas jumlah ronde di `route()` adalah lapisan pertahanan
tambahan, bukan mekanisme utamanya.

### 4.6 Finalisasi dan estimasi Retry-After

Item yang tidak memiliki kandidat tersisa difinalisasi berdasarkan cara
berakhirnya yang terakhir:

- berakhir karena mismatch kapabilitas → error provider diteruskan apa adanya;
- berakhir karena kapasitas atau kesehatan → fail fast dengan estimasi waktu.

Estimasi diambil dari `min` atas seluruh kandidat yang masih relevan dari
`max(earliestReadyAt(upstream), retryAt dari outcome)`. Upstream yang sudah terbukti
mismatch dikecualikan: upstream itu tidak akan pernah melayani item tersebut,
sehingga menyertakannya hanya akan membuat estimasi terlalu optimistis.

Nilai akhirnya dijepit ke rentang 500 ms – 30.000 ms. Untuk batch, estimasi yang
dipakai adalah nilai terbesar di antara item yang kelaparan, agar retry tidak
datang sebelum semua item siap.

### 4.7 Semantik batch

`packages/kiseki/src/batch/index.ts` hanya mengurus bentuk: mengubah body menjadi
item, menolak yang tidak mungkin dirutekan, dan mengembalikan jawaban ke urutan
asli klien. Routing-nya ada di modul lain.

Tiga perilaku yang perlu diketahui:

1. **Urutan dipertahankan.** Setiap hasil membawa `originalIndex`, dan penggabungan
   mengurutkan berdasarkan nilai itu.
2. **Sukses parsial adalah normal.** Kegagalan satu item tidak pernah membuang
   hasil item lain.
3. **Batch kosong** dijawab dengan satu objek error, sesuai JSON-RPC 2.0, bukan
   dengan array kosong.

`params` wajib posisional. Parameter bernama ditolak dengan `-32600` karena tidak
ada metode Ethereum yang memakainya, dan menerimanya akan membuat classifier buta
terhadap argumen blok — kesalahan kapabilitas yang baru ketahuan dari provider.

Item yang tidak valid di dalam batch menerima `-32600` pada indeksnya sendiri,
sementara item lain tetap dijalankan.

### 4.8 Namespace kanonik

Namespace `kiseki_*` memberi klien satu bentuk yang stabil meskipun provider di
belakangnya berbeda. Implementasinya berupa tabel terjemahan per instance yang
memetakan nama kanonik ke nama upstream beserta fungsi pemetaan parameter dan
hasil. Router tidak berubah sama sekali: bagi router, `kiseki_*` hanyalah metode
biasa yang kebetulan didukung sebagian provider.

**Kontrak translasi.** Setiap entri tabel memiliki dua fungsi pemetaan:

- `mapRequest(params, chain)` menerima parameter kanonik dari klien, yang selalu
  berupa array posisional (§4.7). Hasilnya dikirim apa adanya sebagai `params`
  JSON-RPC ke upstream, sehingga bentuknya mengikuti dokumentasi provider: array
  posisional atau objek bernama. JSON-RPC 2.0 mengizinkan keduanya.
- `mapResponse(result, params, chain)` menerima hasil sukses upstream, parameter
  kanonik asli, dan nama chain, lalu mengembalikan hasil kanonik. Nama chain
  diberikan oleh engine karena hasil kanonik wajib memuatnya, sementara respons
  provider belum tentu menyertakannya.

Keduanya adalah pemetaan bentuk murni, tanpa I/O dan tanpa cache.

Keputusan penting:

- **Cakupan diturunkan, bukan dikonfigurasi.** Metode kanonik hanya diiklankan bila
  metode upstream di belakangnya tercakup oleh daftar `methods:` instance. Jika
  operator mempersempit `methods:`, metode kanonik ikut hilang. Konsekuensinya
  cakupan bersifat per (provider × plan).
- **Kegagalan pemetaan bukan mismatch kapabilitas.** `mapRequest` yang mengembalikan
  `undefined` berarti parameter kanonik tidak valid, yaitu kesalahan klien: item
  dijawab langsung sebagai domain error tanpa fetch dan tanpa regroup. Upstream-nya
  baik-baik saja; request-nya yang salah.
- **`mapResponse` yang melempar error juga final**, karena mencoba upstream lain
  tidak dapat memperbaiki fungsi pemetaan.

Error dari provider tidak pernah diterjemahkan; error tersebut diteruskan apa
adanya, sesuai prinsip passthrough. Biaya item kanonik dihitung memakai nama metode
upstream, sehingga tarif provider yang sebenarnya tetap berlaku. Hanya transport
`"jsonrpc"` yang berjalan saat ini (§11).

---

## 5. Model kuota dan cost

### 5.1 Bucket dan identitas

Satu apikey memiliki satu himpunan bucket, satu per dimensi limit. Bucket
diidentifikasi oleh `(provider, token)` dan **dibagi** ke semua instance chain yang
mereferensikan token yang sama. Satu 429 pada satu chain karena itu langsung terlihat
di chain lain.

Refill bersifat kontinu dan lazy: nilai dihitung saat dibaca, tanpa timer. Kredit
dapat menjadi negatif setelah pemotongan yang melebihi saldo, dan itu memang
disengaja — lebih baik menagih penuh di muka daripada mengirim request yang
kuotanya belum tentu tersedia.

Identitas di-encode dengan prefiks panjang, bukan pemisah biasa, agar token yang
mengandung karakter pemisah tidak dapat bertabrakan dengan pasangan lain.

Karena identitas menentukan bucket, dua instance dengan nilai `provider:` sama akan
berbagi satu himpunan bucket. Bila jumlah bucket pada kedua instance berbeda,
bucket dibangun ulang dan pemakaian yang sudah tercatat hilang tanpa peringatan;
bila jumlahnya sama, kapasitas dan laju diperbarui di tempat dan kredit dijepit ke
kapasitas baru. Karena itu instance yang diukur dalam satuan berbeda harus memakai
`provider:` berbeda.

### 5.2 Headroom dan bobot

```
headroom = min atas bucket(credits / capacity)
```

Nilai itu dijepit ke rentang 0–1. Bobot sebuah instance adalah Σ headroom seluruh
apikey yang tidak sedang cooldown; key yang sedang cooldown menyumbang 0 karena
tidak dapat melayani. Nilai inilah yang dilaporkan adapter sebagai bobot ke router
(§4.4).

Di dalam pool, pemilihan apikey memakai weighted-random yang proporsional terhadap
sisa kredit, sehingga prinsipnya sama dengan level 1: kapasitas riil menentukan
porsi.

### 5.3 Cost

Biaya satu panggilan adalah jumlah biaya seluruh item di dalamnya. Untuk provider
yang menagih per panggilan HTTP, biaya yang dipakai adalah item termahal, bukan
jumlahnya.

Biaya per item diselesaikan berlapis:

```
override instance (costs:)  →  tabel provider (hooks.costs)  →  defaults.costs  →  1
```

Kunci tabel boleh berupa nama metode persis atau prefiks berakhiran `*`, dengan
pencocokan persis selalu menang dan prefiks terpanjang menang di antara prefiks.
Angka `0` sah dan berarti metode gratis; hanya angka yang hilang atau tidak dapat
dipakai yang jatuh ke lapisan berikutnya.

Lapisan dicoba secara utuh, bukan per kunci. Override instance untuk `trace_*`
karena itu tetap menang atas nilai provider untuk `trace_block`, sesuatu yang akan
terbalik bila tabel hanya digabung biasa.

Metode yang tidak dikenal lapisan provider tetap dapat jatuh ke lapisan global,
sehingga tabel provider tidak perlu mencakup semuanya.

Eligibility sebuah key hanya mensyaratkan biaya item termahal, bukan total grup.
Grup besar tetap dapat dilayani bucket kecil; key masuk ke posisi utang lalu mengisi
ulang. Ini konservatif dan tidak pernah terlalu optimistis.

### 5.4 Loop percobaan level 2

```
for setiap key yang belum dicoba dan mampu membayar:
    potong kuota (sinkron, sebelum fetch, tanpa refund)
    kirim HTTP
    ├─ sukses / domain error → selesai, kembalikan outcome
    ├─ 429                   → cooldown key, lanjut ke key berikutnya
    ├─ 5xx / timeout         → cooldown eksponensial key, lanjut
    └─ sendRaw ambigu        → hentikan seluruh pool dengan outcome ambiguous
```

Loop berhenti karena setiap iterasi menambahkan tepat satu key ke himpunan `tried`.
Ketika tidak ada key tersisa, pool mengembalikan `rate_limited` atau `sick` beserta
estimasi waktu siap.

Pemotongan dilakukan per percobaan, bukan per grup. Failover ke key kedua berarti
kedua key membayar biaya grup tersebut, meskipun hanya satu yang benar-benar
melayani. Ini konsekuensi langsung dari aturan "potong sebelum kirim, tanpa refund":
pada saat request pertama dikirim, belum ada cara mengetahui bahwa upstream akan
menolaknya.

### 5.5 Kesehatan dua level

| Kejadian | Efek |
|---|---|
| Sukses | Reset hitungan kegagalan berurutan pada key |
| `429` | Saldo semua bucket key didorong ke 0, key diparkir sampai refill |
| `5xx` / timeout | Cooldown eksponensial per key: 1 s → 2 s → … maksimum 60 s |
| Kegagalan pada sejumlah key berbeda | Seluruh provider diparkir dengan backoff eksponensial 1 s → 60 s |

Ambang kegagalan lintas-key bersifat default dan tidak dikonfigurasi. Tujuannya
membedakan "satu key bermasalah" dari "provider sedang bermasalah": yang pertama
diselesaikan dengan failover, yang kedua dengan mengistirahatkan instance.

Level backoff provider tidak pernah turun; lihat §10.

`429` adalah pernyataan tentang limit, bukan tentang kesehatan, sehingga cooldown-nya
tidak eksponensial. Sebaliknya `5xx`, timeout, dan kegagalan koneksi adalah sinyal
kesehatan dan memakai backoff eksponensial.

---

## 6. Penanganan error

### 6.1 Reaksi terhadap outcome

| Outcome | Reaksi |
|---|---|
| `success` | Catat entri; jika ada `unsupportedItems`, item tersebut masuk regroup dan sisanya selesai |
| `domain_error` | Final. Jawaban node yang sah (revert, nonce terlalu rendah) tidak di-failover |
| `unsupported` | Seluruh item grup masuk regroup; instance ditandai sudah dicoba |
| `rate_limited` | Instance ditandai sudah dicoba, lanjut ke kandidat berikutnya |
| `sick` | Sama seperti `rate_limited` |
| `ambiguous` | Hentikan kedua level untuk grup tersebut; semua item grup yang belum terjawab menerima `-32007` |

Pada level 2, `ambiguous` juga menghentikan seluruh pool: tidak ada key lain yang
dicoba, karena hasil broadcast yang tidak diketahui tidak boleh diperkuat oleh klaim
dari key lain.

Penghentian ini berlaku per grup. Grup lain dalam request yang sama, termasuk item
READ pada batch yang sama, tetap dirutekan seperti biasa karena kelas idempotensi
adalah bagian dari kunci grup (§4.3).

### 6.2 Sinyal mismatch kapabilitas

Mismatch dibuktikan oleh tiga keluarga sinyal:

| Sinyal | Dimensi |
|---|---|
| kode `-32601` (metode tidak ada) | `method` |
| pesan state hilang atau terpangkas | `archive` |
| pesan blok tidak ditemukan pada query historis | `archive`, agresif |

Keluarga terakhir hanya berlaku untuk query historis, karena blok yang sudah dibuang
node non-arsip terlihat identik dengan blok yang memang tidak pernah ada. Kiseki
menerima kemungkinan false positif secara sadar: biayanya satu ronde routing
tambahan, sedangkan manfaatnya adalah classifier yang tetap deterministik.

Paket provider dapat mempersempit atau menambah tabel fallback lewat
`matchCapability`. Nilainya `"method"`, `"archive"`, atau `null`; `null` berarti
"bukan mismatch saya" sehingga tabel generik tetap dijalankan. Error domain node
(`execution reverted`, `nonce too low`, `insufficient funds`) harus berujung `null`
agar diteruskan final apa adanya.

Setiap mismatch yang terbukti menghasilkan catatan runtime dan satu regroup. Error
aslinya baru menjadi jawaban klien ketika tidak ada upstream tersisa (§4.6).

### 6.3 Kode error proxy

| Kode | Arti | Sumber |
|---|---|---|
| `-32000` | unauthorized, atau internal proxy error | proxy |
| `-32005` | seluruh upstream rate-limited | proxy (fail fast) |
| `-32006` | tidak ada upstream sehat | proxy (fail fast) |
| `-32007` | status broadcast tidak diketahui | proxy (`sendRawTransaction`) |
| `-32600` | request bukan JSON-RPC 2.0 yang valid, parameter bernama, batch kosong, atau rute tidak dikenal | proxy |
| `-32601` | metode tidak didukung atau diblokir kebijakan | proxy (pre-flight) |
| `-32602` | chain tidak dikenal, atau parameter kanonik tidak valid | proxy |
| `-32603` | kegagalan pemetaan namespace kanonik, atau transport translasi yang belum diimplementasi | proxy |
| lainnya | error provider | diteruskan apa adanya |

Prinsipnya: passthrough menang atas penemuan. Proxy hanya mengarang error untuk
jawaban yang memang ia yang menulis — pre-flight, fail fast, broadcast ambigu, dan
request yang rusak.

### 6.4 Status HTTP

`handle()` hanya mengembalikan `200` atau `429`. Aturan `429` bersifat eksak, bukan
heuristik: **setiap** item dalam respons harus gagal karena kapasitas atau kesehatan.
Satu jawaban nyata — bahkan satu error provider — membuat statusnya `200`, karena
klien punya sesuatu yang bisa ditindaklanjuti dan `Retry-After` menyeluruh akan
menjadi kebohongan untuk item tersebut.

Header `Retry-After` dikirim dalam detik bulat, dibulatkan ke atas, minimum 1.

Status di luar itu ditangani lapisan HTTP: `401` untuk autentikasi gagal, `404` untuk
chain tidak dikenal dan rute tidak dikenal, `500` untuk bug yang tidak terduga.

### 6.5 Pesan tidak pernah memuat rahasia

Seluruh pembangun error di `packages/kiseki/src/errors.ts` hanya menyebut chain,
metode, atau label. Token tidak pernah masuk ke `message` maupun `data`, karena
keduanya berjalan ke klien dan ke log. Path yang tidak dikenali di-redaksi: hanya
segmen pertama (nama chain, bukan rahasia) yang dipertahankan, sisanya diganti `*`.

---

## 7. Konfigurasi

### 7.1 Pipeline konfigurasi

Konfigurasi adalah satu berkas YAML. Pemrosesannya berlapis dan setiap lapisan gagal
cepat dengan melaporkan **semua** masalah yang terlihat sekaligus, agar satu restart
cukup untuk memperbaiki seluruh typo.

```
YAML mentah
  │  parse (yaml) — dilakukan SEBELUM interpolasi, agar ${VAR} di dalam komentar
  │                  tidak ikut disubstitusi
  ▼
interpolasi ${VAR}          config/interpolate.ts
  │  variabel yang tidak ada = error fatal, bukan string kosong
  ▼
validasi bentuk (zod)       config/schema.ts
  │  strict object: kunci tak dikenal ditolak
  ▼
validasi lintas-field       config/validate.ts
  │  keunikan, nama reserved, pola metode, konsistensi identitas apikey
  ▼
buildModel                  config/load.ts
  │  satu adapter per instance, semuanya berbagi satu BucketRegistry
  ▼
Runtime                     runtime.ts
```

Skema bersifat strict dengan alasan operasional: field yang salah ketik (misalnya
`arcive: true`) tidak boleh diam-diam membuat upstream kehilangan kapabilitas arsip
dan baru ketahuan sebagai capability mismatch di runtime.

Validasi lintas-field menegakkan aturan yang tidak bisa dinyatakan oleh skema:

| Aturan | Konsekuensi bila dilanggar |
|---|---|
| Nama instance unik secara global | instance kedua ditolak |
| `url_template` wajib memuat `{apikey}` | semua apikey akan menuju URL yang sama |
| Label apikey unik di dalam instance | dua key tidak dapat dibedakan di metrik |
| Satu identitas `(provider, token)` wajib memakai satu label di semua chain | bucket yang sama tampil dengan dua nama |
| Nama chain tidak boleh menabrak rute tetap (`metrics`, `healthz`) | rute tetap tertutup |
| Pola metode dan kunci cost hanya boleh wildcard di akhir | pola tidak pernah cocok, biaya jatuh ke 1 |
| Metode yang diblokir tidak boleh diklaim eksplisit oleh upstream | kontradiksi antara kebijakan dan kapabilitas |
| Nilai `package:` harus terdaftar di composition root | startup gagal, bukan fallback diam-diam |

Chain tanpa upstream arsip hanya menghasilkan peringatan, bukan error: chain itu
sekadar tidak dapat melayani query historis.

### 7.2 Konsep di kiseki.yaml

Yang penting dipahami dari konfigurasi adalah konsepnya, bukan nilai contohnya:

| Konsep | Makna |
|---|---|
| `server` | Port, host, dan allowlist kunci klien beserta labelnya |
| `server.auth.methods` | Kanal mana yang aktif: `path`, `bearer`, atau keduanya |
| `defaults.costs` | Lapisan cost paling bawah, berlaku untuk semua provider |
| `defaults.timeouts` | Timeout default dan timeout kelas berat, beserta daftar pola kelas berat |
| `defaults.blocked_methods` | Metode yang ditolak kebijakan sebelum routing |
| `chains.<nama>.upstreams[]` | Instance upstream yang melayani chain tersebut |
| `upstreams[].provider` | Identitas bucket. Sama di dua chain berarti bucket dibagi; berbeda berarti terpisah |
| `upstreams[].package` | Adapter mana yang membangun instance ini (§3.2) |
| `upstreams[].url_template` | URL dengan placeholder `{apikey}` |
| `upstreams[].apikeys[]` | Daftar token, label, dan spesifikasi bucket per dimensi limit |
| `upstreams[].methods` | Pola metode yang diklaim instance; dasar kapabilitas statis |
| `upstreams[].archive` | Klaim mampu melayani state historis |
| `upstreams[].costs` | Override cost untuk instance ini — lapisan paling atas |
| `upstreams[].counts_batch_as_one_request` | Provider menagih per panggilan HTTP, bukan per item |
| `upstreams[].timeout_ms` | Override timeout untuk instance ini |
| `limits.max_total_attempts` | Katup pengaman jumlah percobaan per grup; `0` = tanpa batas |
| `metrics.enabled` | Niat operator untuk menonaktifkan `/metrics` (§11) |

`provider:` dan `package:` sengaja dipisah. `provider:` menjawab "bucket ini milik
siapa", `package:` menjawab "adapter mana yang membangun instance ini". Dua instance
dapat memakai `package:` yang sama dengan `provider:` yang berbeda, dan itu memang
bentuk yang benar ketika satu provider diukur dalam satuan berbeda di endpoint
berbeda.

### 7.3 Pemetaan konfigurasi ke runtime

`runtime.ts` adalah satu-satunya modul yang memahami konfigurasi sekaligus routing.

| Nilai konfigurasi | Menjadi |
|---|---|
| `defaults.timeouts` | `TimeoutPolicy` → classifier → `Group.timeoutMs` |
| `defaults.costs` | `CoreDeps.globalCosts` → cost resolver di pool |
| `defaults.blocked_methods` | daftar blokir pada classifier |
| `limits.max_total_attempts` | batas percobaan per grup di router |

Nilai `timeout_ms` pada satu instance tetap menang atas nilai grup, dan `runtime.ts`
sengaja tidak menyelesaikan presedensi itu lebih awal agar aturannya tetap berada di
satu tempat, yaitu di dalam pool.

### 7.4 Reload dan state

Reload dipicu `SIGHUP` dan dijalankan di belakang listener yang sama, sehingga tidak
ada koneksi yang terputus.

| State | Perlakuan saat reload |
|---|---|
| Konfigurasi ter-parse | Diganti |
| Bucket registry (per identitas) | Dipertahankan — identitas sama, kredit sama |
| Cooldown (per identitas) | Dipertahankan — hidup pada objek yang sama |
| Catatan kapabilitas runtime | Direset |
| Metrics | Dipertahankan — registry dan counter yang sama |
| Apikey yang dihapus | Bucket-nya dibuang |

Adapter juga dipertahankan bila konfigurasi instance-nya tidak berubah. Pool menyimpan
daftar key dan cooldown tingkat provider, sehingga membangun ulang semua adapter pada
setiap reload akan mereset kesehatan yang sudah terbentuk.

Keputusan "tidak berubah" diambil dari fingerprint konfigurasi yang mencakup URL,
token, spesifikasi bucket, kapabilitas, biaya, akuntansi batch, dan override timeout.
Karena kapabilitas termasuk di dalamnya, adapter yang dipakai ulang dijamin cocok
dengan konfigurasi baru, dan pre-flight tidak dapat berselisih dengan pool.

Kebijakan kegagalan: reload yang gagal validasi tidak mengubah apa pun. Konfigurasi
yang sedang berjalan tetap melayani. Sebuah typo tidak boleh menjatuhkan proxy yang
sedang bekerja — itulah alasan reload dipilih daripada restart.

---

## 8. Invarian

Daftar berikut adalah sifat yang harus tetap benar ketika kode berubah. Melanggar
salah satunya berarti melanggar arsitektur, bukan sekadar mengubah implementasi.

1. Kuota dipotong sebelum request dikirim, sekali per percobaan, tanpa refund (§5.3,
   §5.4).
2. Tidak ada antrean. Ketika seluruh item gagal karena kapasitas atau kesehatan,
   klien menerima `429` dengan `Retry-After` dalam rentang 500 ms – 30.000 ms (§4.6,
   §6.4).
3. Outcome ambigu pada `eth_sendRawTransaction` menghentikan kedua level routing
   (§6.1).
4. Loop regroup berhenti karena himpunan `tried` tidak pernah menyusut (§4.5).
5. Setiap item dalam respons membawa `originalIndex`, dan hasil diurutkan berdasarkan
   nilai itu (§4.7).
6. Kegagalan satu item tidak pernah membuang hasil item lain (§4.7).
7. Sebuah item hanya dikirim ke upstream yang kapabilitas statisnya mencakup item
   tersebut, dikurangi yang sudah dibuktikan sebaliknya oleh catatan runtime (§4.2).
8. Router tidak pernah menyentuh bucket; ia hanya membaca skalar dari adapter (§4.4).
9. `kiseki_*` hanya diiklankan bila metode upstream di belakangnya tercakup
   `methods:` pada instance tersebut (§4.8).
10. Status `429` hanya diberikan bila seluruh item gagal karena kapasitas atau
    kesehatan (§6.4).
11. Token tidak pernah muncul di log, metrik, pesan error, atau respons (§3.7, §6.5).
12. Lapisan routing hanya bergantung pada kontrak `UpstreamAdapter`, tidak pernah pada
    implementasi adapter tertentu (§3.2, §3.5).

---

## 9. Keputusan desain

Tabel ini tidak memakai nomor keputusan; rujuk barisnya berdasarkan judul. Sel
berisi `—` berarti tidak ada alternatif yang tercatat.

| Keputusan | Alasan | Alternatif yang ditolak |
|---|---|---|
| Routing dua level; router tidak pernah melihat apikey | Pool mengurus kuota dan failover key; router hanya membaca skalar, sehingga model kuota dapat berubah tanpa mengubah router | — |
| Kuota sebagai token bucket dengan refill kontinu dan lazy | Limit provider berbeda-beda tetapi semuanya dapat dinyatakan sebagai laju dan kapasitas; nilai dihitung saat dibaca, tanpa timer | — |
| Kredit boleh menjadi negatif | Lebih baik menagih penuh di muka daripada mengirim request yang kuotanya belum tentu tersedia | — |
| Cost berlapis, dan lapisan dicoba secara utuh | Override instance untuk `trace_*` harus menang atas nilai provider untuk `trace_block` | Menggabung tabel biasa: presedensi exact-vs-prefix menjadi terbalik |
| Eligibility key memakai biaya item termahal | Grup besar tetap dapat dilayani bucket kecil; key masuk posisi utang lalu mengisi ulang | — |
| Kuota dipotong per percobaan, tanpa refund | Pada saat request pertama dikirim belum ada cara mengetahui upstream akan menolaknya | — |
| Fail fast, tanpa antrean | Antrean tidak menambah kapasitas; klien menerima `429` beserta estimasi waktu | — |
| Kapabilitas statis, dikoreksi saat runtime | Konfigurasi tetap sumber kebenaran, tetapi config usang tidak boleh menjadi error permanen bagi klien | — |
| Signature `block not found` historis diperlakukan sebagai mismatch arsip | Classifier tetap deterministik; kesalahan classifier tetap terkoreksi lewat regroup | — |
| Passthrough menang atas penemuan | Error node yang sah tidak diubah dan tidak di-retry | — |
| Translasi kanonik dideklarasikan paket provider, dieksekusi pool engine | Pengetahuan provider tetap di paket provider; core hanya menyediakan mekanisme; router tidak berubah | Tetap meneruskan metode provider apa adanya; translasi di router atau server kiseki; satu tabel translasi global di core |
| Cakupan `kiseki_*` diturunkan dari `methods:` instance | Cakupan per (provider × plan) cukup diatur dengan menyempitkan `methods:` atau mengurangi entri translasi | Cakupan yang dikonfigurasi terpisah |
| Parameter kanonik tidak valid adalah domain error final | Upstream tidak bersalah; request-nya yang salah, sehingga regroup hanya akan membakar kuota | Regroup untuk kasus parameter tidak valid |
| Dua instance dengan `provider:` berbeda untuk satuan limit yang berbeda | `provider:` adalah identitas bucket; jumlah bucket yang berbeda membangun ulang bucket dan menghapus pemakaian yang tercatat | Dua instance dengan identitas provider yang sama |
| Skema config strict | Typo tidak boleh diam-diam menghapus kapabilitas dan baru ketahuan sebagai capability mismatch di runtime | — |
| Parse YAML sebelum interpolasi `${VAR}` | `${VAR}` di dalam komentar tidak boleh ikut disubstitusi | — |
| Variabel environment yang hilang adalah error fatal | Proxy tidak boleh berjalan dengan key kosong | String kosong sebagai pengganti |
| Autentikasi diputuskan sebelum chain diresolusi | Proxy tidak boleh menjadi oracle bagi daftar chain yang ada | — |
| Token dibandingkan dalam bentuk digest SHA-256 | Perbandingan tidak membocorkan panjang atau prefiks yang cocok | — |
| `?apikey=` ditolak, bukan diabaikan | Mengabaikannya membuat klien mengira sudah terautentikasi padahal belum | Mengabaikan parameter query |
| `params` klien wajib posisional | Menerima parameter bernama membuat classifier buta terhadap argumen blok | Menerima parameter bernama |
| Objek metrics adalah observer | Sebuah metrik tidak dapat ada tanpa event yang menggerakkannya | Lapisan adapter terpisah |
| Counter didorong event, gauge ditarik saat scrape | Kredit dan cooldown berubah terhadap waktu | Gauge yang di-push: membeku pada nilai request terakhir |
| Reload, bukan restart | Typo tidak boleh menjatuhkan proxy yang sedang bekerja | Restart untuk setiap perubahan konfigurasi |
| Adapter dipertahankan bila fingerprint konfigurasi tidak berubah | Membangun ulang semuanya akan mereset kesehatan yang sudah terbentuk | Membangun ulang semua adapter pada setiap reload |
| Satu berkas `registry.ts` sebagai composition root | Satu tempat yang mengenal semua provider; router tetap buta provider | — |
| Classifier tidak menebak kebutuhan arsip | Salah menandai "arsip" membuang seluruh upstream non-arsip untuk request yang tidak membutuhkannya | Menebak posisi blok yang tidak dikenal |
| Classifier tidak menghitung biaya | Tabel biaya berlapis per provider; menaruhnya di classifier menduplikasi logika di tempat yang salah | Perhitungan biaya di classifier |

---

## 10. Batasan yang diketahui

Bagian ini mencatat perilaku yang sudah diketahui dan **disengaja**, agar tidak
dikira bug saat membaca kode. Hal yang belum berfungsi ada di §11.

- **State hanya di memori.** Kredit, cooldown, dan catatan kapabilitas hilang saat
  proses berhenti. Bucket dimulai penuh setiap restart, sehingga tidak ada carry over
  pemakaian kuota antar-restart.
- **Satu proses, satu tenant.** Tidak ada isolasi antar-klien selain label pada
  metrik dan log.
- **Tanpa WebSocket dan tanpa subscription.** Hanya JSON-RPC lewat HTTP POST.
- **Tanpa persistensi konfigurasi terakhir yang valid.** Setelah restart, berkas
  konfigurasi harus valid; tidak ada salinan cadangan yang dipakai otomatis.
- **Backoff provider tidak pernah turun.** Hitungan kegagalan lintas-key di-reset
  oleh keberhasilan, tetapi level backoff provider tidak. Setelah beberapa kali
  sakit, cooldown provider selalu berada di batas atasnya, yaitu 60 detik (§5.5).
- **Kuota bulanan provider tidak dimodelkan.** Bucket mengatur laju, bukan kuota
  periodik. Bila provider menolak karena kuota periodik habis, kejadian itu terlihat
  sebagai error biasa, bukan sebagai `429` dari Kiseki.

---

## 11. Yang belum berfungsi

Bagian ini mencatat kode yang sudah ada tetapi belum tersambung, sehingga perilakunya
belum seperti yang tersirat dari nama atau konfigurasinya.

- **`PipelineDeps.tip` tidak pernah diisi.** Field itu ada dan dipakai classifier,
  tetapi runtime tidak menyediakannya. Akibatnya setiap nomor blok eksplisit
  diklasifikasikan sebagai historis — arah yang konservatif: kandidat menyempit,
  tetapi query tidak pernah dikirim ke node yang tidak mampu melayaninya.
- **`metrics.enabled` belum berpengaruh.** Nilainya divalidasi dan tersimpan, dan
  server mengembalikan `404` bila metrics tidak tersedia, tetapi jalur startup selalu
  membangun metrics. Menonaktifkannya belum mengubah perilaku.
- **`KISEKI_DEBUG_BODIES` belum tersambung.** Flag dan helper `debugBodiesEnabled`
  sudah ada beserta aturan scrubbing-nya, tetapi belum ada pemanggil. Body request
  saat ini tidak pernah masuk ke log.
- **`transport: "http"` pada translasi kanonik belum diimplementasi.** Entri dengan
  transport itu tidak diiklankan di `capability()`, dan bila tetap terpanggil
  dijawab sebagai error final tanpa mengirim request. Hanya `"jsonrpc"` yang
  berjalan.

---

## 12. Glosarium

| Istilah | Arti |
|---|---|
| **Instance** | Satu entri `upstreams[]` pada konfigurasi: satu `url_template`, satu daftar apikey, satu klaim kapabilitas |
| **Provider** | Nilai `provider:` — identitas bucket. Instance dengan nilai ini sama berbagi bucket |
| **Package** | Nilai `package:` — adapter yang membangun instance, dipetakan di composition root |
| **Apikey** | Token upstream beserta label dan spesifikasi bucket-nya |
| **Bucket** | Pasangan `capacity` dan `refill_per_second` untuk satu dimensi limit |
| **Identitas** | Pasangan `(provider, token)` yang menjadi kunci bucket dan cooldown, dibagi lintas chain |
| **Headroom** | `min(credits / capacity)` atas seluruh bucket sebuah key, dijepit 0–1 |
| **Bobot** | Σ headroom seluruh apikey instance; dasar weighted-random di level 1 |
| **Kelas metode** | `default` atau `heavy`; kelas berat memakai timeout panjang |
| **Kapabilitas statis** | Pola metode plus flag arsip yang diklaim konfigurasi |
| **Catatan runtime** | Memori proses yang mencatat mismatch yang sudah terbukti, per instance |
| **Pre-flight** | Pemeriksaan kapabilitas sebelum request dikirim; penolakan di sini tidak memotong kuota |
| **Grup** | Sekumpulan item yang berbagi kandidat belum dicoba, kebutuhan arsip, dan kelas idempotensi |
| **Regroup** | Mengembalikan item yang terbukti mismatch ke antrean untuk dicoba ke upstream lain pada request yang sama |
| **Outcome** | Taksonomi hasil satu percobaan: `success`, `domain_error`, `unsupported`, `rate_limited`, `sick`, `ambiguous` |
| **Fail fast** | Menolak dengan `429` dan estimasi waktu, bukan mengantre |
| **Passthrough** | Meneruskan error provider apa adanya tanpa diterjemahkan atau di-retry |
| **Namespace kanonik** | Namespace `kiseki_*` yang netral terhadap provider, diturunkan dari tabel translasi |
| **Ambigu** | Hasil `eth_sendRawTransaction` yang tidak dapat dipastikan; menghentikan failover untuk grup tersebut |
| **Fingerprint** | Sidik konfigurasi satu instance; dipakai memutuskan adapter boleh dipakai ulang saat reload |
| **Scrubber** | Penyaring yang mengganti setiap kemunculan secret pada log dengan penanda redaksi |
