# 4xx non-JSON-RPC dan penolakan key: masalah konfigurasi, bukan kesehatan

| | |
|---|---|
| **Jenis** | Proposal desain |
| **Status** | Diimplementasikan |
| **Tanggal** | 23 November 2026 |
| **Komponen** | `upstream-core` (klasifikasi respons, ApiKeyState, ApikeyPool, kontrak adapter, taksonomi outcome), `kiseki` (router, tabel kode error), dokumentasi arsitektur |
| **Prasyarat** | Tidak ada |

---

## Ringkasan

Respons HTTP 4xx (selain 401, 403, dan 429) yang body-nya **bukan** amplop JSON-RPC
saat ini diperlakukan sebagai `client_error` — "request-nya yang salah, mencoba di
tempat lain tidak akan membantu" — tetapi pool tidak menjalankan maksud itu: body
non-JSON tetap di-parse, gagal, dan berujung failover key, parkir provider, serta
klien menerima `429` / `-32006`. Masalah konfigurasi (apikey salah) menyamar jadi
masalah kapasitas. Penolakan 401/403 menderita salah diagnosis yang sama: reason
`server_error` menyalakan penghitung kegagalan lintas-key, sehingga apikey Alchemy
yang salah juga memarkir provider dan klien menerima `429` / `-32006`.

Yang diusulkan:

1. `classifyResponse` memilah 4xx non-401/403/429 dengan satu uji bentuk body:
   **bukan objek/array JSON** → kelas baru **`misconfigured`**; objek/array JSON →
   tetap `client_error` (jawaban node sah, termasuk yang memakai `id: null`,
   di-parse per item seperti hari ini).
2. Pool menangani `misconfigured` **dan** `unauthorized` sebagai **kegagalan
   konfigurasi key, bukan kesehatan provider**: key tetap diberi cooldown
   eksponensial, tetapi kegagalan ini tidak menambah `crossKeyFailures` dan tidak
   memarkir provider.
3. **Alasan cooldown dicatat di `ApiKeyState`** (tingkat identitas `(provider,
   token)`, dipakai bersama semua instance yang mereferensikan key itu),
   lengkap dengan status HTTP penolakan terakhir, dan diagnosis **diturunkan
   dari kondisi key**, bukan disimpan sebagai snapshot di pool: upstream
   dianggap salah konfigurasi hanya bila **setiap** key-nya sedang cooldown
   dengan alasan salah konfigurasi. Router membacanya lewat satu accessor
   skalar baru pada `UpstreamAdapter`, melewatkan upstream yang sedang salah
   konfigurasi **tanpa fetch dan tanpa pemotongan kuota**, memfinalisasi item
   sebagai `-32008` bila tidak ada kandidat lain, dan mengecualikannya dari
   estimasi `Retry-After` — sehingga diagnosis tetap benar pada request-request
   berikutnya selama cooldown, di instance mana pun key itu dipakai.
4. Outcome baru di taksonomi, `{ kind: "misconfigured"; status? }`, dan kode error
   proxy baru **`-32008`** dengan pesan `"upstream is misconfigured"` (keduanya
   sudah disepakati): respons akhirnya HTTP `200` + `-32008`, bukan `429` +
   `-32006`.
5. Untuk `eth_sendRawTransaction`: hasil 4xx non-JSON-RPC tetap `ambiguous`
   (`-32007`, menghentikan kedua level) karena catatan riset tidak menyatakan
   apakah penolakan gateway terjadi sebelum request sampai ke node — tetapi key
   yang menolak tetap mencatat alasan salah konfigurasi, sehingga request
   berikutnya selama cooldown mendapat `-32008`, bukan `-32005`. Hasil 401/403
   tetap failover seperti hari ini, tetapi finalisasinya ketika semua key menolak
   berubah dari `sick` / `429` / `-32006` menjadi `200` / `-32008`.

Yang diminta dari reviewer: persetujuan atas kelas klasifikasi baru, perluasan
cakupan ke `unauthorized`, outcome baru, kode error `-32008`, pencatatan alasan
cooldown di `ApiKeyState`, dan **penambahan satu member pada kontrak
`UpstreamAdapter`**.

---

## Masalah

Catatan riset *Ankr Advanced API* (bagian "apikey salah") mendokumentasikan,
TERUKUR di kedua endpoint Ankr: apikey yang salah dijawab gateway dengan
**HTTP 404 dan body HTML nginx** (`content-type: text/html`, bukan JSON sama
sekali), bukan balasan JSON-RPC. Catatan yang sama membandingkan: Alchemy
membalas apikey salah dengan **401 JSON yang valid** — jadi kedua provider
menunjukkan kelas masalah yang sama (konfigurasi) dengan bentuk respons berbeda.

Rantai kegagalan di kode saat ini:

1. `classifyResponse` menandai 404 sebagai `client_error` dengan komentar bahwa
   request-nya sendiri yang salah dan mencoba di tempat lain tidak akan membantu.
2. Pool memperlakukan `client_error` sama seperti `ok`, lalu menyerahkan body ke
   `classifyBody`.
3. Body HTML gagal di-parse; semua item jatuh ke `missing`; pool menganggap
   upstream tidak sehat: key di-failover, kegagalan lintas-key menumpuk, provider
   diparkir, dan klien akhirnya menerima `429` / `-32006`
   "no healthy upstream available".
4. Untuk `eth_sendRawTransaction`, kondisi yang sama dianggap ambigu, sehingga
   klien menerima `-32007` dan failover berhenti.
5. Jalur 401/403 (`unauthorized`) mengembalikan reason `server_error` ke loop
   attempt. Akibatnya `sawServerFailure` menyala dan `crossKeyFailures` bertambah:
   apikey Alchemy yang salah, setelah ambang lintas-key tercapai, juga memarkir
   provider dan klien menerima `429` / `-32006`. Salah diagnosis yang sama, hanya
   beda jalur.

Ada masalah keenam yang menentukan bentuk desain: **diagnosis harus bertahan
melampaui request pertama.** Cooldown yang benar (key yang menolak diistirahatkan)
membuat `weight()` upstream jatuh ke 0 selama cooldown. Router hanya memilih
upstream dengan `weight > 0`, dan item yang tidak pernah dicoba difinalisasi
sebagai `rate_limited`. Akibatnya, tanpa mekanisme tambahan, setiap request
berikutnya selama masa cooldown (sampai 60 detik) tidak pernah memanggil adapter
dan klien menerima `429` / `-32005` dengan `Retry-After` berupa sisa cooldown key
yang salah — salah diagnosis yang sama yang ingin diperbaiki, hanya berpindah
dari `-32006` ke `-32005`. Penanganan outcome di request pertama saja tidak
cukup; router harus dapat mengetahui bahwa upstream berbobot 0 **karena masalah
konfigurasi**.

Kesalahan diagnosis yang dihasilkan (tercatat di catatan riset untuk kasus Ankr,
dan berlaku identik untuk kasus 401):

- **Klien melihat 429** (limit) padahal penyebabnya apikey salah. Operator yang
  melihat 429 akan menaikkan bucket, bukan memeriksa `.env`.
- **Kegagalan konfigurasi menyamar jadi kegagalan kapasitas.** Kelas bug yang
  mahal karena mengarahkan troubleshooting ke tempat yang salah.

Akar masalahnya ada di core, bukan di paket provider: komentar pada kelas
`client_error` menyatakan maksud ("request-nya yang salah"), tetapi pool tidak
pernah memverifikasi bahwa body memang jawaban JSON-RPC sebelum menindaklanjuti
maksud tersebut. Komentar itu sendiri juga belum tentu benar untuk kasus ini:
apikey yang salah di satu upstream tidak berarti upstream lain juga gagal, dan
request klien tidak terbukti salah — yang ditolak adalah panggilan ke gateway
upstream tersebut.

---

## Tujuan dan non-tujuan

### Tujuan

- Respons 4xx non-JSON-RPC tidak lagi terlihat klien sebagai `429` / `-32006`,
  pada request pertama **maupun** pada request-request berikutnya selama masa
  cooldown.
- Penolakan 401/403 tidak lagi memarkir provider, sehingga apikey yang salah di
  provider mana pun (Ankr maupun Alchemy) tidak lagi menyamar sebagai kegagalan
  kesehatan.
- Key yang menolak tetap kehilangan bobot melalui cooldown, sehingga gateway tidak
  ditembak terus dan kuota tidak terbakar pada laju penuh.
- Request selama masa diagnosis tidak menembak gateway, tidak memotong kuota, dan
  tetap menghasilkan `200` / `-32008` — bukan `429` / `-32005` dengan
  `Retry-After` sisa cooldown.
- Diagnosis hanya aktif bila **setiap** key instance sedang cooldown karena
  salah konfigurasi — key yang belum dicoba, sedang cooldown karena kesehatan,
  atau sedang cooldown karena 429 menggugurkan diagnosis.
- Estimasi `Retry-After` tidak pernah memakai cooldown upstream yang salah
  konfigurasi, pada request mana pun.
- Klien dan operator dapat membedakan masalah konfigurasi dari masalah kapasitas
  lewat status HTTP, kode error, log, dan metrik.
- Perilaku untuk 4xx yang body-nya amplop JSON-RPC sah (termasuk `id: null`)
  **tidak berubah**.
- Jaminan send-safe tidak berubah.
- Tidak ada aturan khusus satu provider di core.

### Non-tujuan

- Mengubah klasifikasi 401/403 (`unauthorized`) dan 429 (`rate_limited`) di
  `classifyResponse`: keduanya tetap kelasnya sendiri. Yang berubah hanya cara
  pool menindaklanjuti `unauthorized`.
- Mengubah perilaku `unauthorized` untuk `eth_sendRawTransaction` selama attempt
  (failover antar key, bukan ambiguous): perilaku yang sudah berlaku dan sudah
  teruji; menyentuhnya adalah keputusan terpisah.
- Mengubah kebijakan kuota: pemotongan tetap terjadi sebelum pengiriman, tanpa
  refund, untuk setiap attempt yang benar-benar dikirim. Request yang di-skip
  lewat sinyal diagnosis tidak mengirim apa pun, jadi tidak memotong apa pun.
- Memperkenalkan retry khusus atau mekanisme konfigurasi ulang otomatis.
- Mengubah cara router menghitung `Retry-After` untuk kasus yang sudah ada.

---

## Proposal

### 1. Klasifikasi: `misconfigured` di `classifyResponse`

Aturan, berurutan (status di atas 2xx):

1. `429` → `rate_limited` (tidak berubah).
2. `401` / `403` → `unauthorized` (klasifikasi tidak berubah; penanganan pool
   berubah, lihat §2).
3. `5xx` → `server_error` (tidak berubah).
4. **4xx lain** dipilah dengan satu uji bentuk murni atas body:
   - Body ter-parse sebagai JSON dan berbentuk **objek tunggal atau array** →
     tetap `client_error`. Uji ini sengaja konsisten dengan domain input
     `classifyBody`, yang menerima objek tunggal maupun array dan mencocokkan
     amplop tanpa mewajibkan `id` — respons tunggal tanpa `id` dicocokkan lewat
     posisi, dan error JSON-RPC sah sering memakai `id: null`. Body kosong, HTML,
     teks biasa, JSON primitif (`"null"`, angka, string) → `misconfigured`.
   - Selain itu → kelas baru `{ kind: "misconfigured"; status }`.
5. `client_error` kehilangan arti "mencoba di tempat lain tidak akan membantu":
   untuk 4xx ber-body JSON objek/array, isi body-lah yang menentukan (domain error
   per item, final, tanpa failover) — perilaku yang sudah berlaku dan tetap.

Pengujian body hidup di `result.ts` sebagai fungsi murni tanpa I/O, sehingga
seluruh matriks tetap bisa diuji unit tanpa jaringan. Tidak ada pengait
provider-specific: deteksinya bentuk body, bukan isi string ("nginx", header
`content-type: text/html`), sehingga berlaku untuk Ankr maupun gateway lain.

Konsekuensi yang diketahui: gateway yang menjawab 4xx dengan **objek JSON
sembarangan** (bukan amplop) jatuh ke jalur `client_error`, gagal dicocokkan, dan
diperlakukan sebagai body rusak — persis perilaku hari ini. Itu batas yang
diterima; uji lebih ketat (mewajibkan `result`/`error`) akan mengubah perilaku
respons node yang sah tanpa `id`, dan uji yang mewajibkan `id` salah terhadap
`id: null`.

### 2. `ApiKeyState`: alasan cooldown dicatat di tingkat identitas

`KeyHealth` (pada `bucket.ts`) bertambah dua field:

```ts
/** Alasan cooldown yang sedang berlaku; undefined saat key tidak cooldown. */
cooldownReason?: "misconfigured" | "unhealthy" | "rate_limited"
/** Status HTTP penolakan terakhir bila alasan `misconfigured`. */
misconfiguredStatus?: number
```

Aturan penulisannya — **penulis terakhir menjelaskan cooldown yang sedang
berjalan**:

- `markFailure(nowMs, reason)` bertambah parameter reason: `"unhealthy"` untuk
  jalur 5xx/timeout/transport (nilai lama), `"misconfigured"` untuk jalur
  kelas `misconfigured` dan `unauthorized` (401/403 dan 4xx non-JSON-RPC —
  keduanya penolakan kunci/gateway, kelas masalah yang sama: konfigurasi).
  Saat reason `"misconfigured"` diisi, status HTTP penolakan terakhir ikut
  disimpan di `misconfiguredStatus`.
- `markRateLimited` mengisi `"rate_limited"`: 429 adalah pernyataan tentang
  limit, bukan konfigurasi. Bila key yang sebelumnya ditolak karena konfigurasi
  nanti kena 429, alasan cooldown yang berlaku berubah menjadi
  `"rate_limited"` — dan sebaliknya, penolakan konfigurasi berikutnya
  menimpa alasan 429/5xx. Kondisi `cooldownUntilMs` hanya pernah bertambah,
  jadi alasan selalu menjelaskan cooldown terpanjang yang aktif; kalau label
  meleset sesaat, key pertama yang pulih dicoba ulang dan balasannya
  menulis ulang kebenarannya.
- `markSuccess` menghapus alasan dan status (beserta `consecutiveFailures`,
  seperti sekarang): key yang berhasil melayani bukan lagi key yang bermasalah.
- Saat cooldown berakhir, alasan tidak perlu dihapus: kondisi turunan selalu
  menguji `cooldownRemainingMs > 0` **dan** alasan, jadi alasan basi tanpa
  cooldown tidak berpengaruh.

Ini **koreksi atas draf sebelumnya** yang mengklaim "tidak ada state baru di
key": ada dua field baru, dan keduanya hidup di `ApiKeyState` yang identity-keyed
`(provider, token)` — artinya diagnosis otomatis terlihat oleh **setiap**
instance chain yang mereferensikan key yang sama, bukan hanya instance yang
melihat penolakannya.

Cooldown-nya sendiri tidak berubah: eksponensial 1 s → 2 s → … maksimum 60 s,
memakai `markFailure` yang sudah ada. Alasannya:

- key yang salah kehilangan bobot: `weight()` melewatkan key yang sedang
  cooldown, sehingga router berhenti memilihnya dan setiap request tidak lagi
  membayar kuota + latensi untuk satu percobaan yang pasti gagal;
- backoff eksponensial membatasi pemborosan kuota: laju tembak ulang turun cepat
  dan terkunci pada maksimum satu percobaan per key per 60 detik;
- cooldown per apikey sudah identity-keyed sehingga terlihat di gauge
  `kiseki_apikey_cooldown_seconds_remaining`;
- cooldown tetap (mis. 30 s konstan) ditolak: laju pemborosan konstan lebih
  tinggi dan tidak ada manfaat tambahan, karena salah konfigurasi tidak
  menyembuhkan diri dengan menunggu.

Sisanya kebijakan attempt tidak berubah dari draf sebelumnya:

- **Tidak menambah `crossKeyFailures`** — penolakan konfigurasi tidak ikut
  memarkir provider.
- **Tidak ada `markSuccess`** — panggilan tidak berhasil; kuota yang sudah
  dipotong tetap hangus.
- Failover ke key berikutnya: apikey yang salah tidak berarti key lain pada
  instance yang sama juga salah.
- `RetryReason` bertambah `"misconfigured"`, terpisah dari `"server_error"`,
  sehingga loop attempt tidak menyalakan `sawServerFailure`. Cabang
  `unauthorized` berubah mengembalikan reason ini (sebelumnya `"server_error"` —
  inilah sumber salah diagnosis jalur 401).
- Label outcome untuk `onKeyAttempt`: `unauthorized` untuk 401/403 (tetap),
  **`misconfigured`** untuk 4xx non-JSON-RPC (label baru pada
  `kiseki_pool_key_attempts_total`). Log warn menyebut status HTTP, instance
  tempat penolakan terjadi, dan label key — **isi body tidak pernah masuk
  log**, karena body balasan gateway tidak dijamin bersih dari rahasia. Nama
  instance **tidak pernah masuk error klien**: klien yang menerima `-32008` di
  instance lain menelusuri sumbernya lewat log, bukan lewat `data`.
- **Path `ambiguous` sendRaw tetap mencatat alasan**: untuk kelas
  `misconfigured` pada grup `NON_IDEMPOTENT`, key yang menolak tetap
  `markFailure(nowMs, "misconfigured")` sebelum outcome `ambiguous` dikembalikan
  (lihat §6).

### 3. Taksonomi: outcome `{ kind: "misconfigured"; status? }`, diturunkan dari kondisi key

`UpstreamOutcome` bertambah satu varian. Pool mengembalikannya hanya bila
**setelah attempt selesai** kondisi turunan berlaku: **setiap** key instance
sedang cooldown dengan `cooldownReason === "misconfigured"`. Kondisi yang sama
yang menyalakan accessor adapter (§4) — satu definisi, dua konsumen. Bila
kondisi tidak berlaku, pool berperilaku seperti hari ini: `sick` bila ada
kegagalan server sungguhan pada attempt ini, selain itu `rate_limited` dengan
`retryAtMs` = `earliestReadyAt()`.

Konsekuensi dari syarat "setiap key" (dengan sengaja, sesuai semantik key):

- Key yang **tidak pernah dicoba** pada attempt ini (mis. gagal `canAfford`
  karena bucket habis) tidak sedang cooldown dengan alasan konfigurasi → kondisi
  gagal → pool mengembalikan `rate_limited` / `-32005`, karena key itu memang
  akan pulih. Bukan `misconfigured`.
- Key yang **sedang cooldown karena 5xx atau 429** dari request sebelumnya,
  dicampur key yang ditolak 401 pada request ini → kondisi gagal (alasan
  cooldown campur) → pool mengembalikan `rate_limited` (atau `sick` bila ada
  kegagalan server pada attempt ini). Diagnosis konfigurasi tidak menyapu key
  yang bermasalah karena kesehatan atau kapasitas.
- Satu key salah + satu key sehat pada instance yang sama: request dilayani key
  sehat, `markSuccess` berjalan, kondisi gagal — tidak ada diagnosis.

`status` membawa nomor status HTTP penolakan terakhir (`misconfiguredStatus`
dari key yang menolak, lihat §2), murni untuk `data` error klien.

Router bereaksinya seperti `rate_limited`/`sick` — upstream ditandai sudah
dicoba, loop lanjut ke kandidat berikutnya (apikey salah di satu upstream tidak
berarti upstream lain gagal, jadi menghentikan routing di sini salah) — tetapi
`lastEnd` item menerima alasan baru, `{ kind: "misconfigured"; status? }`, dan
`onAttempt` melaporkan label `misconfigured` pada `kiseki_upstream_attempts_total`.

Untuk grup `NON_IDEMPOTENT`, **kelas** `misconfigured` (4xx non-JSON-RPC yang
terjadi selama attempt) diperlakukan `ambiguous` — lihat §6.

### 4. Kontrak adapter: satu accessor skalar baru

`UpstreamAdapter` bertambah satu member:

```ts
/** Diagnosis konfigurasi aktif, diturunkan dari kondisi key. Skalar baca-saja. */
misconfigured(): { untilMs: number; status?: number } | undefined
```

- Implementasinya di pool: aktif bila **setiap** key instance memenuhi
  `cooldownRemainingMs(now) > 0 && cooldownReason === "misconfigured"`;
  `untilMs` = cooldown yang **paling cepat berakhir** di antara key-key itu
  (`min` atas `cooldownUntilMs`). Artinya begitu satu key pulih, diagnosis
  terangkat dan key itu dicoba ulang secara normal — balasannya kemudian
  menulis ulang kebenaran kondisinya.
- `status` berasal dari `misconfiguredStatus` pada key-key yang sedang cooldown
  karena konfigurasi (diambil dari key dengan cooldown paling cepat berakhir).
  Karena status tersimpan di `ApiKeyState`, instance chain lain yang memakai
  key yang sama punya status yang sama — tidak ada yang hilang saat diagnosis
  lintas chain.
- Karena `ApiKeyState` identity-keyed, instance chain lain yang memakai key
  yang sama menurunkan diagnosis yang sama dari state bersama itu — tanpa
  menyimpan apa pun di pool-nya.
- Implementasi lain dan fake adapter pada test router mengembalikan
  `undefined` (tidak sedang salah konfigurasi); test yang membutuhkan
  menyetelnya lewat injeksi.
- Ini **koreksi atas draf sebelumnya**: kontrak adapter berubah — satu member
  baru, wajib untuk semua implementasi. Ia tetap konsisten dengan prinsip bahwa
  router hanya membaca skalar dari adapter dan tidak pernah menyentuh bucket
  (invariant 8): accessor ini membaca kondisi kesehatan key, bukan isi bucket,
  dan polanya sama dengan `weight()` serta `earliestReadyAt()` yang sudah ada.
- Alternatif "snapshot diagnosis di pool" ditolak — lihat Alternatif #9.
- Alternatif "tidak menambah member, andalkan attempt() yang cepat-balik"
  ditolak: router hanya memilih upstream dengan `weight > 0`, dan selama
  cooldown bobotnya 0 — `attempt()` tidak pernah dipanggil, jadi outcome apa
  pun yang dikembalikan attempt tidak pernah sampai ke router. Tanpa accessor,
  router buta.

### 5. Router: memilih, finalisasi, dan estimasi

Tiga mekanisme, semuanya di level router:

**(a) Pemilihan.** Di setiap iterasi loop grup, upstream kandidat yang
`misconfigured()`-nya aktif **di-skip**: tidak dipilih, tanpa fetch, tanpa
pemotongan kuota, dan tidak ditandai `tried` (ia bukan attempt; makna `tried`
tetap "pernah diattempt"). Ini yang membuat request kedua dan berikutnya selama
masa diagnosis tidak menembak gateway sama sekali.

**(b) Estimasi `Retry-After`.** `estimateRetryAfter` mengecualikan upstream yang
`misconfigured()`-nya aktif, **dicek langsung pada adapter pada saat estimasi** —
terlepas dari sumber pengetahuannya (outcome attempt pada request yang sama,
atau kondisi turunan request sebelumnya). Alasannya: menunggu tidak menyembuhkan
salah konfigurasi — cooldown kedaluwarsa, key dicoba ulang, penolakan yang sama
terjadi — sehingga sisa cooldown upstream tersebut tidak boleh masuk angka;
memasukkannya lewat `earliestReadyAt()` adalah kebohongan ke arah lain. Ini
perluasan dari pengecualian `mismatched` yang sudah ada, dan kini berlaku pada
request mana pun.

**(c) Finalisasi.** Pemetaan `lastEnd` ke error (yang dipakai hanya ending
terakhir):

| Ending terakhir | Error klien |
|---|---|
| mismatch kapabilitas | error provider, verbatim (tidak berubah) |
| `misconfigured` (dari attempt) | `-32008`, tanpa estimasi |
| `sick` | `-32006` (tidak berubah) |
| `rate_limited`, atau tidak ada ending attempt | `-32005` + estimasi (tidak berubah, kecuali pengecualian (b)) |

ditambah satu aturan untuk finalisasi **tanpa attempt** (semua kandidat di-skip
atau berbobot 0):

> Bila item tidak punya ending attempt pada request ini dan **setiap** kandidat
> tersisa (dikurangi yang mismatched) sedang salah konfigurasi menurut
> accessor-nya, item difinalisasi `-32008` — dengan `data.status` dari accessor
> bila diketahui, tanpa estimasi.

Aturan ini yang menutup request-request berikutnya: satu upstream salah
konfigurasi yang sedang cooldown → `200` / `-32008` tanpa fetch. Bila masih ada
kandidat tersisa yang tidak misconfigured (mis. satu upstream parkir karena
`rate_limited`), aturan itu tidak berlaku dan jalur lama berjalan: `-32005`
dengan estimasi yang hanya memakai upstream yang bisa melayani — klien diberi
waktu retry yang berguna, bukan `-32008` yang menyiratkan semuanya rusak.

Semantik "ending terakhir" tetap literal: `misconfigured` diikuti `rate_limited`
di upstream lain (pada request yang sama) berujung `-32005` — item belum terbukti
mustahil, hanya upstream ini yang bermasalah konfigurasi, dan itu jawaban yang
jujur.

**Keputusan (disepakati):** kode error proxy barunya adalah **`-32008`**
(`ERROR_UPSTREAM_MISCONFIGURED`), pesannya **"upstream is misconfigured"**:

```json
{"code": -32008, "message": "upstream is misconfigured", "data": {"status": 404}}
```

`data.status` hanya berisi nomor status HTTP. Karena flag kapasitas tidak
di-set, `shapeResponse` menghasilkan **HTTP `200`**, bukan `429`: tidak ada
`Retry-After` yang bisa dijanjikan dengan jujur untuk masalah konfigurasi, dan
aturan eksak §6.4 ("429 hanya bila seluruh item gagal karena kapasitas atau
kesehatan") otomatis terpenuhi.

Catatan observabilitas: finalisasi lewat sinyal pasif tidak menambah counter
attempt (`kiseki_upstream_attempts_total` menghitung attempt, dan tidak ada
attempt yang terjadi); diagnosisnya tetap terlihat lewat log warn attempt yang
membentuknya, gauge cooldown key, dan kode `-32008` yang diterima klien.

### 6. `eth_sendRawTransaction`

- **Kelas `misconfigured` (4xx non-JSON-RPC) selama attempt tetap `ambiguous`:**
  `-32007`, menghentikan kedua level, tanpa retry. Catatan riset tidak menyatakan
  apakah penolakan gateway (HTTP 404 HTML Ankr) terjadi **sebelum** request
  sampai ke node; dari luar tidak bisa dibuktikan. Jaminan send-safe tidak
  melemah: tidak ada jalur baru yang menyatakan "request belum sampai ke node"
  tanpa bukti. Log warn `sendRaw ambiguous` memuat reason `misconfigured`
  sehingga operator dapat melihat indikasi konfigurasi, tetapi klien untuk
  request sendRaw itu tetap menerima `-32007`.
- **Alasan konfigurasi tetap dicatat di key meski outcome-nya ambiguous**: key
  yang menolak menerima `markFailure(nowMs, "misconfigured")` sebelum outcome
  `ambiguous` dikembalikan. Tanpa ini, request berikutnya selama cooldown akan
  menerima `-32005` — salah diagnosis lagi. Karena loop attempt berhenti pada
  penolakan pertama yang ambigu, diagnosis tingkat upstream menjadi aktif hanya
  setelah **setiap** key instance pernah menolak dengan kelas ini; sampai saat
  itu, key yang belum menolak dicoba seperti biasa (dan setiap penolakan
  mencatat alasannya). Untuk instance satu key — bentuk umum Ankr — diagnosis
  aktif sejak penolakan pertama.
- **Kelas `unauthorized` (401/403) tetap failover antar key** seperti hari ini.
  Yang berubah adalah **hasil akhirnya ketika semua key menolak**: sebelumnya
  reason `server_error` menyalakan jalur `sick` → klien menerima `429` / `-32006`;
  sesudahnya kondisi turunan berlaku → outcome `misconfigured` → router
  memfinalisasi `-32008` dengan HTTP `200`. Ini perubahan yang disengaja dan
  diuji (Validasi #8).
- Request berikutnya selama masa diagnosis, untuk grup sendRaw pun, di-skip
  tanpa fetch (§5a) dan difinalisasi `-32008` bila tidak ada kandidat lain
  (§5c). Ini send-safe: request yang di-skip tidak pernah dikirim, jadi tidak
  ada ketidakpastian broadcast yang disembunyikan di balik `-32008`.

### 7. Reload: perbaikan konfigurasi berlaku segera untuk penolakan konfigurasi

Cooldown kesehatan (5xx) dan 429 **tidak** disentuh reload — itu sinyal tentang
provider yang masih benar setelah config diubah. Alasan `misconfigured` berbeda:
kemungkinan besar penyebabnya ada di config instance itu sendiri (apikey atau
`url_template`), jadi saat operator memperbaiki config, diagnosis lama justru
menahan instance yang sudah benar. Maka, saat reload:

- Untuk setiap identitas `(provider, token)` yang dipakai instance yang
  config-nya berubah, bila `cooldownReason`-nya `"misconfigured"`, alasan
  beserta statusnya **dihapus**, dan cooldown key itu dibatalkan
  (`cooldownUntilMs` kembali 0, `consecutiveFailures` di-reset).
- Cooldown dengan alasan lain (`unhealthy`, `rate_limited`) dibiarkan apa
  adanya, termasuk pada identitas yang sama.
- Identitas yang tidak dipakai instance mana pun yang berubah tidak tersentuh —
  diagnosis mereka tetap berlaku sampai cooldown habis atau key berhasil
  melayani.

Efeknya: perbaikan `url_template` atau apikey yang salah berlaku pada request
pertama setelah reload, tanpa menunggu sisa cooldown (maksimum 60 detik).
Test-nya ada di Validasi #11.

### 8. Apa yang dilihat klien dan operator

| Permukaan | Sebelum | Sesudah |
|---|---|---|
| Klien, READ, 4xx non-JSON-RPC, request pertama | `429` + `-32006` "no healthy upstream" | `200` + `-32008` "upstream is misconfigured", `data.status` |
| Klien, READ, request berikutnya selama cooldown | `429` + `-32005`, `Retry-After` = sisa cooldown key yang salah | `200` + `-32008`, tanpa fetch, tanpa pemotongan kuota |
| Klien, READ, 401/403 | `429` + `-32006` (setelah provider parkir) | `200` + `-32008`, `data.status: 401/403` |
| Klien, sendRaw, 4xx non-JSON-RPC | `-32007` | `-32007` (tidak berubah) |
| Klien, sendRaw, 401/403, semua key menolak | `429` + `-32006` (jalur sick) | `200` + `-32008`; failover antar key tidak berubah |
| Klien, key lain belum dicoba / cooldown kesehatan atau 429 campur | `429` + `-32005` | tetap `429` + `-32005` (diagnosis tidak menyapu) |
| Status HTTP respons | `429` + `Retry-After` palsu untuk kasus konfigurasi | `200` untuk kasus konfigurasi |
| Log pool | "upstream failure"/"apikey rejected"/"sendRaw ambiguous" lalu "provider sick" | warn per key (status HTTP) tanpa parkir provider; sendRaw 4xx tetap warn ambiguous |
| Metrik level 2 | `kiseki_pool_key_attempts_total{outcome="bad_body"|"server_error"}` | label baru `outcome="misconfigured"`; `unauthorized` tetap |
| Metrik level 1 | `kiseki_upstream_attempts_total{outcome="sick"}` | label baru `outcome="misconfigured"`; finalisasi lewat sinyal pasif tidak menambah counter attempt |
| Sinyal kesehatan | provider diparkir 1 s → 60 s | tidak ada parkir; key cooldown eksponensial tetap berjalan dan terlihat di gauge |

Operator membedakan: `429`/`-32006` dengan parkir provider = masalah kapasitas
atau kesehatan; `200` + `-32008` = periksa konfigurasi apikey/url instance itu
(401/403 menunjuk key, 4xx lain menunjuk gateway/rute). Gauge cooldown key tetap
menunjukkan key yang menolak sedang diistirahatkan.

---

## Alternatif yang dipertimbangkan

1. **Perlakukan 4xx non-JSON-RPC sebagai `server_error`** (sinyal kesehatan,
   parsing dilewati). Ditolak: diagnosis menyesatkan tetap ada — provider tetap
   diparkir dan klien tetap menerima `429`/`-32006` untuk masalah `.env`.
2. **Teruskan sebagai error domain final tanpa failover** (jalankan maksud lama
   `client_error` secara harfiah). Ditolak: premisnya salah. Yang ditolak gateway
   adalah panggilan berikut apikey/URL-nya, bukan request klien, dan apikey yang
   salah di satu upstream tidak menunjuk kebatasan upstream lain. Klien juga akan
   menerima error yang tidak menjelaskan apa pun tentang upstream-nya.
3. **Deteksi provider-specific di core** (`content-type: text/html`, string
   "nginx"). Ditolak: core tidak boleh mengenal provider, dan sniffing
   `content-type` rapuh — gateway lain bisa memakai bentuk berbeda. Uji bentuk
   objek/array JSON bersifat generik dan mencakup semua kasus ini.
4. **Perlakukan penolakan gateway sebagai bukti "belum sampai ke node"** untuk
   sendRaw (varian `reachedNode: false`). Ditolak: catatan riset tidak
   mendokumentasikan itu; invariant 3 (ambiguous menghentikan kedua level) tidak
   boleh melemah tanpa bukti terukur.
5. **Pertahankan cakupan (401/403 tetap sinyal kesehatan), hapus klaim campuran,
   tunda masalah ini sebagai satu kelas.** Ditolak: salah diagnosis yang sama
   persis tetap terjadi lewat jalur 401 — apikey Alchemy yang salah memarkir
   provider dan klien menerima `429`/`-32006`, dan catatan riset sendiri
   mendokumentasikan bahwa Alchemy menolak apikey salah dengan 401. Membiarkannya
   berarti membiarkan separuh kelas masalah tetap salah diagnosis, dan taksonomi
   menjadi tidak konsisten: penolakan yang sama (key ditolak upstream) dinilai
   "kesehatan" untuk 401 tetapi "konfigurasi" untuk 404 HTML.
6. **Cooldown tetap (konstan) untuk key yang menolak.** Ditolak: laju pemborosan
   kuota konstan dan lebih tinggi daripada backoff eksponensial yang dikunci di
   maksimum satu percobaan per 60 detik, tanpa manfaat tambahan — salah konfigurasi
   tidak menyembuhkan diri dengan menunggu.
7. **Sertakan upstream `misconfigured` dalam estimasi `Retry-After` lewat cooldown
   key-nya.** Ditolak: `earliestReadyAt()` akan menggelembungkan angka dengan sisa
   cooldown yang tidak membantu siapa pun — menunggu tidak menyembuhkan salah
   konfigurasi. Mengecualikannya (seperti `mismatched`) menghasilkan angka yang
   hanya mencerminkan upstream yang bisa melayani.
8. **Andalkan `attempt()` yang cepat-balik `misconfigured`, tanpa member adapter
   baru.** Ditolak: router hanya memilih upstream dengan `weight > 0`; selama
   cooldown bobot upstream yang salah konfigurasi adalah 0, jadi `attempt()`
   tidak pernah dipanggil dan outcome apa pun tidak pernah sampai ke router.
   Inilah alasan accessor skalar (§4) diperlukan.
9. **Snapshot diagnosis di pool** (`misconfiguredUntilMs` diisi dari ringkasan
   attempt terakhir). Ditolak, karena salah di tiga skenario: (i) key yang
   ditolak dicampur key yang tidak pernah dicoba karena `canAfford` gagal —
   snapshot menyatakan salah konfigurasi padahal key itu akan pulih, dan
   jawabannya seharusnya `-32005`; (ii) key yang sedang cooldown karena 5xx/429
   dari request sebelumnya dicampur key yang ditolak 401 — snapshot menyatakan
   salah konfigurasi padahal sebabnya kesehatan atau kapasitas; (iii) cooldown
   tersimpan di `ApiKeyState` per identitas dan dipakai bersama instance chain
   lain, sedangkan snapshot per pool — key yang ditolak di instance ethereum
   mendinginkan diri juga di instance base, tetapi pool base tidak punya
   snapshot dan klien di base kembali menerima `429` / `-32005`. Mencatat alasan
   di `ApiKeyState` dan menurunkan kondisi dari key memperbaiki ketiganya dengan
   satu mekanisme.
10. **Sinyal diagnosis pasif menulis `lastEnd` seperti outcome.** Ditolak: pada
    kasus campuran (satu upstream salah konfigurasi sedang cooldown + satu upstream
    parkir karena `rate_limited`), itu memfinalisasi `-32008` padahal masih ada
    kandidat yang akan bisa melayani — klien kehilangan `Retry-After` yang berguna.
    Sinyal pasif bekerja lewat skip (§5a), pengecualian estimasi (§5b), dan aturan
    finalisasi khusus (§5c) yang hanya berlaku bila tidak ada kandidat lain.
11. **Retry diam-diam ke key berikutnya tanpa label/metric baru**. Ditolak:
    menyembunyikan masalah; operator tidak mendapat sinyal apa pun dan kegagalan
    konfigurasi kembali menyamar.
12. **Serahkan klasifikasi ke paket provider** lewat hook. Ditolak: klasifikasi
    HTTP adalah tugas core; paket provider tidak boleh memuat klasifikasi HTTP
    (tabel tanggung jawab dalam pedoman repositori), dan aturan ini bukan
    kekhususan Ankr.

---

## Prinsip yang dipertahankan

- Kuota dipotong sebelum request dikirim, sekali per attempt, tanpa refund —
  attempt `misconfigured` juga membayar; request yang di-skip lewat sinyal tidak
  mengirim apa pun, jadi tidak memotong apa pun (invariant 1).
- Tidak ada antrean; `429` hanya untuk kegagalan kapasitas/kesehatan (invariant 2
  dan 10 — `misconfigured` bukan keduanya, jadi tidak pernah memicu `429`).
- `eth_sendRawTransaction` ambigu menghentikan kedua level (invariant 3) — hasil
  kelas `misconfigured` pada sendRaw juga ambigu.
- Satu apikey = satu set bucket dan kesehatan, identity-keyed dan dipakai bersama
  semua instance yang mereferensikannya — alasan cooldown kini bagian dari
  identitas itu, bukan milik satu pool.
- Router tidak pernah menyentuh bucket; ia hanya membaca skalar dari adapter
  (invariant 8) — accessor `misconfigured()` adalah skalar baca-saja yang
  diturunkan dari kondisi kesehatan key, pola yang sama dengan `weight()` dan
  `earliestReadyAt()`.
- Passthrough menang atas penemuan: jawaban node sah (termasuk 4xx ber-body JSON
  dengan `id: null` atau tanpa `id`) tidak diubah dan tidak di-retry.
- Token tidak pernah muncul di log, metrik, pesan error, atau respons
  (invariant 11) — isi body balasan gateway tidak pernah dicatat.
- Core tetap tanpa aturan provider; paket provider tetap tanpa klasifikasi HTTP.

---

## Dampak

- **`upstream-core`**: `bucket.ts` (**`KeyHealth` bertambah field
  `cooldownReason` dan `misconfiguredStatus`**; `markFailure` bertambah
  parameter reason; `markRateLimited` mengisi `"rate_limited"`; `markSuccess`
  menghapusnya; **operasi baru di `ApiKeyState`/`BucketRegistry` untuk menghapus
  alasan `misconfigured`** — alasan, `misconfiguredStatus`, cooldown, dan
  `consecutiveFailures` di-reset, sementara alasan `unhealthy`/`rate_limited`
  tidak disentuh — dipanggil dari jalur reload `kiseki`), `result.ts` (kelas
  `misconfigured` + uji bentuk body),
  `pool.ts` (cabang `misconfigured`, cabang `unauthorized` berubah reason,
  `RetryReason` baru, derivation kondisi), `adapter.ts` (**satu member baru
  `misconfigured()` pada kontrak `UpstreamAdapter`** — koreksi atas draf
  sebelumnya yang mengklaim kontrak tidak berubah), `types/outcome.ts` (varian
  outcome baru). Semua implementasi adapter dan fake adapter mengembalikan
  `undefined` kecuali yang memang punya diagnosis.
- **`kiseki`**: `errors.ts` (kode `-32008`), `router/index.ts` (`EndReason` baru,
  skip upstream ber-sinyal, pemetaan `lastEnd`, aturan finalisasi tanpa attempt,
  pengecualian estimasi), jalur reload (pembersihan alasan `misconfigured` untuk
  identitas instance yang berubah lewat operasi baru di `BucketRegistry`, §7),
  `test/helpers.ts` (fake adapter menambah member baru, default tidak aktif; test
  yang membutuhkan menyetelnya lewat injeksi), tanpa perubahan server/pipeline —
  `shapeResponse` sudah benar karena flag kapasitas tidak di-set.
- **Dokumentasi**: bagian *Penanganan error* (tabel reaksi outcome, tabel kode
  error proxy, aturan status HTTP), *Kesehatan dua level* (baris untuk
  `misconfigured` dan 401/403), kontrak adapter di bagian arsitektur yang
  menjelaskannya, *Reload dan state* (baris untuk pembersihan alasan
  `misconfigured`), dan daftar *Invarian* tetap konsisten tanpa perubahan teks
  invariant — diperbarui dalam perubahan implementasi yang sama.
- **Metrik**: satu label baru pada dua counter yang sudah ada; tidak ada metrik
  baru.
- **Kompatibilitas**: tidak ada perubahan konfigurasi, tidak ada perubahan wire
  format request klien.

---

## Risiko dan mitigasi

1. **Gateway menjawab 4xx dengan objek JSON sembarangan** (bukan amplop JSON-RPC).
   Mitigasi: jatuh ke jalur `client_error`, gagal dicocokkan, diperlakukan sebagai
   body rusak — persis perilaku hari ini. Diketahui dan diterima; uji lebih ketat
   akan mengubah perilaku respons node sah tanpa `id` (lihat §1).
2. **Body JSON-RPC yang tidak konvensional pada 4xx** (mis. array berisi elemen
   bukan objek). Mitigasi: uji bentuk sengaja mengikuti domain input
   `classifyBody`, sehingga semua body yang hari ini di-parse tetap di-parse; hanya
   body yang hari ini pasti gagal (bukan JSON, bukan objek/array) yang pindah kelas.
3. **401/403 yang sebenarnya sinyal provider turun total** (mis. seluruh key
   dicabut provider). Mitigasi: tidak ada parkir provider, tetapi setiap key tetap
   mendapat cooldown eksponensial (maksimum satu percobaan per key per 60 detik)
   dan router pindah ke upstream lain lewat outcome `misconfigured`; biaya
   kesalahannya dibatasi backoff, dan log/metrik per key tetap menunjukkan
   penyebabnya.
4. **Riwayat kesehatan key tercampur**: `consecutiveFailures` dipakai bersama
   oleh kegagalan server dan penolakan konfigurasi, sehingga tangga backoff tidak
   membedakan penyebab. Mitigasi: keduanya sama-sama "key ini bermasalah, kurangi
   lajunya"; tangga yang lebih curam untuk key yang bermasalah adalah konservatif
   dan hanya membatasi pemborosan, tidak pernah mengubah jawaban klien. Alasan
   cooldown sendiri selalu menjelaskan penolakan terakhir (penulis terakhir
   menang), dan `cooldownUntilMs` hanya pernah bertambah, jadi label bisa sesaat
   lebih luas dari cooldown yang menyebabkannya — key pertama yang pulih dicoba
   ulang dan balasannya menulis ulang kebenarannya.
5. **Diagnosis kedaluwarsa salah arah**: kondisi turunan otomatis terangkat saat
   cooldown key pertama berakhir (paling lama 60 detik) dan saat key mana pun
   berhasil melayani (`markSuccess`). Salah diagnosis yang tertahan paling lama
   60 detik, dan hanya berupa "upstream ini dilewati", bukan jawaban palsu ke
   klien. Khusus perbaikan lewat reload, ada pembersihan lebih cepat — lihat §7.
6. **Batch campuran: sebagian item sudah terjawab di attempt sebelumnya pada
   request yang sama.** Mitigasi: outcome `misconfigured` dan sinyal pasif hanya
   menyentuh item yang belum terjawab, sama seperti reaksi
   `rate_limited`/`sick` sekarang.
7. **Insiden `-32007` menjadi lebih sulit dihubungkan dengan akar konfigurasi**
   karena klien tidak melihat perbedaannya. Mitigasi: log warn `sendRaw
   ambiguous` memuat reason `misconfigured`, metrik level-2 memakai label
   `misconfigured`, dan key yang menolak mencatat alasan konfigurasi sehingga
   request berikutnya mendapat `-32008` — operator tetap bisa menelusurinya.
8. **Penyebab 4xx non-JSON tidak selalu masalah key, dan alasannya lintas
   instance**: `url_template` yang salah di satu instance juga dijawab gateway
   dengan 404 HTML yang bentuknya sama persis dengan apikey salah. Core tidak
   bisa membedakan kedua penyebab, dan karena alasan cooldown tersimpan per
   identitas `(provider, token)`, instance lain yang memakai key yang sama —
   dengan konfigurasi yang benar — ikut menurunkan diagnosis dan di-skip,
   menerima `-32008`, lalu kembali melayani setiap kali cooldown habis sampai
   penolakan berikutnya. Perilaku ini **disengaja**: cooldown lintas instance
   memang perilaku yang sudah ada (`ApiKeyState` identity-keyed), dan
   memisahkannya berarti menyalin kesehatan per pool — persis jebakan snapshot
   yang ditolak (Alternatif #9). Mitigasinya adalah ketelusuran, bukan
   pemisahan: log warn penolakan menyebut instance tempat penolakan terjadi,
   sehingga operator yang melihat `-32008` di instance lain dapat menemukan
   instance penyebabnya; nama instance tidak pernah masuk error klien. Skenario
   ini diuji (Validasi #4, kasus dua instance).

---

## Validasi

Semua test memakai harness injeksi (`fetchImpl` palsu, `now()` statis) tanpa
jaringan, dan body HTML dikutip verbatim dari catatan riset *Ankr Advanced API*:

1. **READ, 4xx non-JSON-RPC, request pertama** (HTML 404 nginx): key mendapat
   cooldown eksponensial dengan alasan konfigurasi (bobotnya turun),
   `crossKeyFailures` tidak bertambah, provider tidak sakit; failover ke key
   berikutnya; saat setiap key sudah menolak, outcome `misconfigured` kembali ke
   router.
2. **READ, 401/403, request pertama**: sama seperti di atas — cooldown key dengan
   alasan konfigurasi, `crossKeyFailures` tidak bertambah, provider tidak parkir;
   campuran `misconfigured` + `unauthorized` menghasilkan outcome
   `misconfigured`, bukan `sick`.
3. **Dua request berurutan dalam masa cooldown**: request kedua tidak memanggil
   `fetch` sama sekali, tidak memotong kuota, dan tetap menghasilkan `200` /
   `-32008` (bukan `429` / `-32005` dengan `Retry-After` sisa cooldown).
4. **Diagnosis tidak menyapu** (tiga skenario):
   - key A ditolak, key B tidak pernah dicoba karena `canAfford` gagal (bucket
     habis) → `429` / `-32005`, bukan `misconfigured`;
   - key A sedang cooldown karena 5xx/429 dari request sebelumnya, key B ditolak
     401 pada request ini → `429` / `-32005` (atau `sick` bila ada kegagalan
     server pada attempt ini), bukan `misconfigured`;
   - key ditolak pada instance satu chain, lalu request datang ke instance chain
     lain yang memakai key (identitas) yang sama → instance kedua menurunkan
     diagnosis yang sama dari state bersama dan menjawab `-32008` tanpa fetch.
   - **Dua instance dengan satu key, hanya satu yang URL-nya salah**: instance
     dengan URL salah ditolak gateway dan mencatat alasan konfigurasi di key;
     instance dengan URL benar menurunkan diagnosis yang sama dan juga menjawab
     `-32008` selama cooldown. Keduanya lognya membedakan: hanya instance yang
     salah URL yang mencatat warn penolakan; instance yang benar hanya skip
     pasif. (Perilaku ini disengaja — lihat Risiko #8.)
5. **Satu key salah + satu key sehat pada instance yang sama**: request dilayani
   key sehat (`markSuccess`), tidak ada diagnosis, upstream tidak di-skip.
6. **Kasus campuran selama cooldown**: upstream A salah konfigurasi yang sedang
   cooldown + upstream B parkir karena `rate_limited` → item difinalisasi
   `-32005` dengan estimasi yang **tidak memakai cooldown A** (hanya dari B);
   bila semua kandidat sedang salah konfigurasi → `-32008` tanpa estimasi.
7. **Router, kasus end-to-end**: satu upstream `misconfigured` + satu upstream
   sehat → item terjawab oleh upstream sehat; semua upstream `misconfigured` →
   klien menerima `-32008` dengan HTTP `200` dan tanpa `Retry-After`;
   `misconfigured` + `rate_limited` pada request yang sama → `-32005` dengan
   estimasi yang mengecualikan upstream `misconfigured`.
8. **`eth_sendRawTransaction` + 4xx non-JSON-RPC**: outcome `ambiguous`, `-32007`,
   kedua level berhenti; tidak ada retry; key yang menolak mencatat alasan
   konfigurasi, dan request READ maupun sendRaw berikutnya dalam masa cooldown
   dijawab `-32008` tanpa fetch. **`eth_sendRawTransaction` + 401/403**: failover
   antar key tidak berubah, dan ketika setiap key sudah menolak hasilnya berubah
   dari `sick` / `429` / `-32006` menjadi `200` / `-32008`.
9. **4xx dengan body JSON-RPC valid**: perilaku tidak berubah — domain error
   diteruskan final, capability mismatch tetap regroup, termasuk amplop tunggal
   dengan `id: null` dan amplop tanpa `id`.
10. **Kasus lama tidak berubah**: 429, 5xx, transport error, campuran dengan
    `server_error` (jalur `sick` menang), serta pergantian alasan cooldown
    (`markRateLimited` menimpa alasan konfigurasi dan sebaliknya) — seluruh test
    lama lulus tanpa pengecualian yang dibisukan.
11. **Reload**: instance dengan key yang sedang cooldown karena konfigurasi
    mengalami perubahan config (mis. `url_template` diperbaiki) → alasan
    `misconfigured` beserta status dan cooldown-nya dihapus untuk identitas
    yang dipakai instance itu; request berikutnya mengirim ulang tanpa menunggu
    sisa cooldown, sedangkan identitas yang tidak tersentuh reload dan cooldown
    `unhealthy`/`rate_limited` tetap berjalan.
12. `bun run check` lulus penuh sebelum commit.

---

## Pertanyaan terbuka

Tidak ada. Kode error (`-32008`) dan pesan (`"upstream is misconfigured"`) sudah
disepakati dan menjadi keputusan di §5.

---

## Langkah selanjutnya

1. Setelah disetujui: implementasikan sesuai proposal ini (core dulu — alasan
   cooldown di `ApiKeyState`, lalu pool, member adapter baru, router, jalur
   reload, dan tabel kode error), dengan test pada bagian Validasi.
2. Perbarui bagian *Penanganan error*, *Kesehatan dua level*, kontrak adapter,
   dan tabel kode proxy dalam perubahan yang sama.
3. `bun run check` lulus penuh, lalu pindahkan proposal ini ke folder proposal
   terimplementasi dan commit.
