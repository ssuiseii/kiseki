# 4xx non-JSON-RPC dan penolakan key: masalah konfigurasi, bukan kesehatan

| | |
|---|---|
| **Jenis** | Proposal desain |
| **Status** | Diajukan untuk review |
| **Tanggal** | 23 November 2026 |
| **Komponen** | `upstream-core` (klasifikasi respons, ApikeyPool, taksonomi outcome), `kiseki` (tabel kode error, reaksi router), dokumentasi arsitektur |
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
   konfigurasi upstream ini, bukan kesehatan provider**: key tetap diberi cooldown
   eksponensial (mengurangi bobotnya, membatasi pemborosan kuota), tetapi
   kegagalan ini tidak menambah `crossKeyFailures` dan tidak memarkir provider.
3. Outcome baru di taksonomi, `{ kind: "misconfigured"; status? }`, dan kode error
   proxy baru **`-32008`** agar klien dan operator dapat membedakan masalah
   konfigurasi dari masalah kapasitas: respons akhirnya adalah HTTP `200` +
   `-32008`, bukan `429` + `-32006`.
4. Estimasi `Retry-After` mengecualikan upstream yang berujung `misconfigured`,
   sama seperti upstream yang mismatched.
5. Untuk `eth_sendRawTransaction`, hasil `misconfigured` (4xx non-JSON-RPC) tetap
   `ambiguous` (`-32007`, menghentikan kedua level): catatan riset tidak
   menyatakan apakah penolakan gateway terjadi sebelum request sampai ke node.
   Perilaku lama untuk `unauthorized` pada sendRaw (failover, bukan ambiguous)
   tidak disentuh proposal ini.

Yang diminta dari reviewer: persetujuan atas kelas klasifikasi baru, perluasan
cakupan ke `unauthorized`, outcome baru, kode error `-32008`, bentuk cooldown key,
dan kebijakan estimasi `Retry-After`.

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

- Respons 4xx non-JSON-RPC tidak lagi terlihat klien sebagai `429` / `-32006`.
- Penolakan 401/403 tidak lagi memarkir provider, sehingga apikey yang salah di
  provider mana pun (Ankr maupun Alchemy) tidak lagi menyamar sebagai kegagalan
  kesehatan.
- Key yang menolak tetap kehilangan bobot melalui cooldown, sehingga gateway tidak
  ditembak terus dan kuota tidak terbakar pada laju penuh.
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
- Mengubah perilaku `unauthorized` untuk `eth_sendRawTransaction` (failover, bukan
  ambiguous): perilaku yang sudah berlaku dan sudah teruji; menyentuhnya adalah
  keputusan terpisah.
- Mengubah kebijakan kuota: pemotongan tetap terjadi sebelum pengiriman, tanpa
  refund, termasuk untuk attempt yang berujung `misconfigured`.
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

### 2. Pool: kegagalan konfigurasi bukan sinyal kesehatan provider

Di `tryKey`, kelas `misconfigured` dan `unauthorized` ditangani oleh satu kebijakan
yang sama, dengan satu perbedaan label:

- **Cooldown key tetap ada**, memakai `markFailure` yang sudah ada: eksponensial
  1 s → 2 s → … maksimum 60 s. Alasannya:
  - key yang salah tidak kehilangan bobot penuh hanya jika cooldown ada —
    `weight()` melewatkan key yang sedang cooldown, sehingga router berhenti
    memilihnya dan setiap request tidak lagi membayar kuota + latensi untuk satu
    percobaan yang pasti gagal;
  - backoff eksponensial membatasi pemborosan kuota: laju tembak ulang turun cepat
    dan terkunci pada maksimum satu percobaan per key per 60 detik;
  - tidak ada state baru: `consecutiveFailures` per key sudah ada, dan cooldown
    per apikey sudah identity-keyed sehingga terlihat di gauge
    `kiseki_apikey_cooldown_seconds_remaining`.
  - Cooldown tetap (mis. 30 s konstan) ditolak: laju pemborosan konstan lebih
    tinggi dan tidak ada manfaat tambahan, karena salah konfigurasi tidak
    menyembuhkan diri dengan menunggu.
- **Tidak menambah `crossKeyFailures`** — tidak ikut memarkir provider.
- **Tidak ada `markSuccess`** — panggilan tidak berhasil; kesehatan lain tidak
  tersentuh. Kuota yang sudah dipotong tetap hangus.
- Failover ke key berikutnya: apikey yang salah tidak berarti key lain pada
  instance yang sama juga salah.
- `RetryReason` bertambah `"misconfigured"`, terpisah dari `"server_error"`,
  sehingga loop attempt tidak menyalakan `sawServerFailure`. Cabang
  `unauthorized` berubah mengembalikan reason ini (sebelumnya `"server_error"` —
  inilah sumber salah diagnosis jalur 401).
- Label outcome untuk `onKeyAttempt`: `unauthorized` untuk 401/403 (tetap),
  **`misconfigured`** untuk 4xx non-JSON-RPC (label baru pada
  `kiseki_pool_key_attempts_total`). Log warn menyebut status HTTP dan instance
  saja — **isi body tidak pernah masuk log**, karena body balasan gateway tidak
  dijamin bersih dari rahasia.

Ketika semua key habis: jika ada kegagalan server sungguhan, jalur `sick` yang
lama menang (konservatif, tidak berubah); jika attempt berjalan hanya
`misconfigured` dan/atau `unauthorized` — keduanya penolakan kunci/gateway —
pool mengembalikan outcome baru.

### 3. Taksonomi: outcome baru `{ kind: "misconfigured"; status? }`

`UpstreamOutcome` bertambah satu varian. `status` (opsional) membawa nomor status
HTTP penolakan terakhir, murni untuk `data` error klien dan log. Router
bereaksinya seperti `rate_limited`/`sick` — upstream ditandai sudah dicoba, loop
lanjut ke kandidat berikutnya (apikey salah di satu upstream tidak berarti
upstream lain gagal, jadi menghentikan routing di sini salah) — tetapi `lastEnd`
item menerima alasan baru, `{ kind: "misconfigured"; status? }`, dan `onAttempt`
melaporkan label `misconfigured` pada `kiseki_upstream_attempts_total`.

Untuk grup `NON_IDEMPOTENT`, hasil `misconfigured` (4xx non-JSON-RPC) diperlakukan
`ambiguous` — lihat §5. Hasil `unauthorized` untuk sendRaw tidak berubah
(failover; lihat Non-tujuan).

### 4. Finalisasi dan estimasi `Retry-After`

`EndReason` bertambah `{ kind: "misconfigured"; status? }`. Urutan prioritas di
`finalizeItem` menjadi:

1. mismatch kapabilitas → error provider, verbatim (tidak berubah);
2. **`misconfigured` → error proxy `-32008`**, tanpa flag kapasitas;
3. `sick` → `-32006` (tidak berubah);
4. `rate_limited` → `-32005` (tidak berubah).

Error barunya dibangun di lapisan error proxy (kode `ERROR_UPSTREAM_MISCONFIGURED
= -32008`):

```json
{"code": -32008, "message": "upstream is misconfigured", "data": {"status": 404}}
```

`data.status` hanya berisi nomor status HTTP. Karena flag kapasitas tidak
di-set, `shapeResponse` menghasilkan **HTTP `200`**, bukan `429`: tidak ada
`Retry-After` yang bisa dijanjikan dengan jujur untuk masalah konfigurasi, dan
aturan eksak §6.4 ("429 hanya bila seluruh item gagal karena kapasitas atau
kesehatan") otomatis terpenuhi.

**Estimasi `Retry-After` tetap jujur.** Kasus bermasalah: upstream A berujung
`misconfigured`, upstream B berujung `rate_limited`; item difinalisasi dengan
`-32005` dan satu angka `Retry-After`. Estimasi dihitung atas upstream yang bisa
melayani, dan upstream yang berujung `misconfigured` **dikecualikan** dari
estimasi, mekanisme yang sama dengan upstream `mismatched`:

- Menunggu tidak menyembuhkan salah konfigurasi — cooldown key (§2) kedaluwarsa,
  key dicoba ulang, dan penolakan yang sama terjadi. Memasukkannya lewat
  `earliestReadyAt()` hanya menggelembungkan angka dengan waktu yang tidak
  membantu siapa pun; itu kebohongan ke arah lain.
- Mengecualikannya membuat angka hanya mencerminkan upstream yang benar-benar bisa
  melayani (B), sama seperti `mismatched` sudah dikecualikan karena regroup-nya
  tidak akan membantu.
- Alternatif "andalkan cooldown key" ditolak: cooldown menyetop pemilihan di
  level router (bobot 0), tetapi tidak mengoreksi estimasi yang sudah salah.

Semantik "ending terakhir" tetap literal seperti sekarang: `misconfigured` diikuti
`rate_limited` di upstream lain berujung `-32005` — item belum terbukti mustahil,
hanya upstream ini yang bermasalah konfigurasi, dan itu jawaban yang jujur.

### 5. `eth_sendRawTransaction`: hasil 4xx non-JSON-RPC tetap ambigu

Catatan riset tidak menyatakan apakah penolakan gateway (HTTP 404 HTML Ankr)
terjadi **sebelum** request sampai ke node. Ada gateway yang mem-forward ke node
dan ada yang tidak; dari luar tidak bisa dibuktikan. Maka:

- Kelas `misconfigured` pada grup `NON_IDEMPOTENT` → `ambiguous` seperti hari
  ini: `-32007`, menghentikan kedua level, tanpa retry.
- Log warn `sendRaw ambiguous` memuat reason `misconfigured` sehingga operator
  yang menyelidiki insiden `-32007` dapat melihat bahwa penolakan itu berbentuk
  4xx non-JSON-RPC (indikasi konfigurasi), tetapi klien tetap menerima `-32007`.

Jaminan send-safe tidak melemah: tidak ada jalur baru yang menyatakan "request
belum sampai ke node" tanpa bukti. Perilaku lama `unauthorized` untuk sendRaw
(failover tanpa ambiguous) dipertahankan apa adanya dan bukan bagian proposal ini.

### 6. Apa yang dilihat klien dan operator

| Permukaan | Sebelum | Sesudah |
|---|---|---|
| Klien, READ, 4xx non-JSON-RPC | `429` + `-32006` "no healthy upstream" | `200` + `-32008` "upstream is misconfigured", `data.status` |
| Klien, READ, 401/403 | `429` + `-32006` (setelah provider parkir) | `200` + `-32008`, `data.status: 401/403` |
| Klien, sendRaw, 4xx non-JSON-RPC | `-32007` | `-32007` (tidak berubah) |
| Klien, sendRaw, 401/403 | failover (bukan `-32007`) | tidak berubah |
| Status HTTP respons | `429` + `Retry-After` palsu | `200` |
| Log pool | "upstream failure"/"apikey rejected"/"sendRaw ambiguous" lalu "provider sick" | warn per key (status HTTP) tanpa parkir provider; sendRaw 4xx tetap warn ambiguous |
| Metrik level 2 | `kiseki_pool_key_attempts_total{outcome="bad_body"|"server_error"}` | label baru `outcome="misconfigured"`; `unauthorized` tetap |
| Metrik level 1 | `kiseki_upstream_attempts_total{outcome="sick"}` | label baru `outcome="misconfigured"` |
| Sinyal kesehatan | provider diparkir 1 s → 60 s | tidak ada parkir; key cooldown eksponensial tetap berjalan |

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
8. **Retry diam-diam ke key berikutnya tanpa label/metric baru**. Ditolak:
   menyembunyikan masalah; operator tidak mendapat sinyal apa pun dan kegagalan
   konfigurasi kembali menyamar.
9. **Serahkan klasifikasi ke paket provider** lewat hook. Ditolak: klasifikasi
   HTTP adalah tugas core; paket provider tidak boleh memuat klasifikasi HTTP
   (tabel tanggung jawab dalam pedoman repositori), dan aturan ini bukan
   kekhususan Ankr.

---

## Prinsip yang dipertahankan

- Kuota dipotong sebelum request dikirim, sekali per attempt, tanpa refund —
  attempt `misconfigured` juga membayar (invariant 1).
- Tidak ada antrean; `429` hanya untuk kegagalan kapasitas/kesehatan (invariant 2
  dan 10 — `misconfigured` bukan keduanya, jadi tidak pernah memicu `429`).
- `eth_sendRawTransaction` ambigu menghentikan kedua level (invariant 3) — hasil
  `misconfigured` pada sendRaw juga ambigu.
- Passthrough menang atas penemuan: jawaban node sah (termasuk 4xx ber-body JSON
  dengan `id: null` atau tanpa `id`) tidak diubah dan tidak di-retry.
- Token tidak pernah muncul di log, metrik, pesan error, atau respons
  (invariant 11) — isi body balasan gateway tidak pernah dicatat.
- Core tetap tanpa aturan provider; paket provider tetap tanpa klasifikasi HTTP.
- Router tetap tidak menyentuh bucket; ia hanya bereaksi terhadap `kind`.

---

## Dampak

- **`upstream-core`**: `result.ts` (kelas `misconfigured` + uji bentuk body),
  `pool.ts` (cabang `misconfigured`, cabang `unauthorized` berubah reason,
  `RetryReason` baru), `types/outcome.ts` (varian outcome baru). Kontrak
  `UpstreamAdapter` tidak berubah bentuk — hanya nilai `kind` yang bertambah, dan
  router memang sudah generik terhadap `kind`.
- **`kiseki`**: `errors.ts` (kode `-32008`), `router/index.ts` (`EndReason` baru,
  reaksi outcome, finalisasi, pengecualian `misconfigured` pada estimasi
  `Retry-After`), tanpa perubahan server/pipeline — `shapeResponse` sudah benar
  karena flag kapasitas tidak di-set.
- **Dokumentasi**: bagian *Penanganan error* (tabel reaksi outcome, tabel kode
  error proxy, aturan status HTTP), *Kesehatan dua level* (baris untuk
  `misconfigured` dan 401/403), dan daftar *Invarian* tetap konsisten tanpa
  perubahan teks invariant — diperbarui dalam perubahan implementasi yang sama.
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
   dan hanya membatasi pemborosan, tidak pernah mengubah jawaban klien.
5. **Batch campuran: sebagian item sudah terjawab di attempt sebelumnya pada
   request yang sama.** Mitigasi: outcome `misconfigured` hanya menyentuh item
   yang belum terjawab, sama seperti reaksi `rate_limited`/`sick` sekarang.
6. **Insiden `-32007` menjadi lebih sulit dihubungkan dengan akar konfigurasi**
   karena klien tidak melihat perbedaannya. Mitigasi: log warn `sendRaw
   ambiguous` memuat reason `misconfigured`, dan metrik level-2 memakai label
   `misconfigured`, sehingga operator tetap bisa menelusurinya.

---

## Validasi

Semua test memakai harness injeksi (`fetchImpl` palsu, `now()` statis) tanpa
jaringan, dan body HTML dikutip verbatim dari catatan riset *Ankr Advanced API*:

1. **READ, 4xx non-JSON-RPC** (HTML 404 nginx): key mendapat cooldown
   eksponensial (bobotnya turun), `crossKeyFailures` tidak bertambah, provider
   tidak sakit; failover ke key berikutnya; saat semua key dalam cooldown, outcome
   `misconfigured` kembali ke router.
2. **READ, 401/403**: sama seperti di atas — cooldown key ada, `crossKeyFailures`
   tidak bertambah, provider tidak parkir; campuran `misconfigured` + `unauthorized`
   menghasilkan outcome `misconfigured`, bukan `sick`.
3. **Router, kasus end-to-end**: satu upstream `misconfigured` + satu upstream
   sehat → item terjawab oleh upstream sehat; semua upstream `misconfigured` →
   klien menerima `-32008` dengan HTTP `200` dan tanpa `Retry-After`;
   `misconfigured` + `rate_limited` → `-32005` dengan estimasi yang mengecualikan
   upstream `misconfigured`.
4. **`eth_sendRawTransaction` + 4xx non-JSON-RPC**: outcome `ambiguous`, `-32007`,
   kedua level berhenti; tidak ada retry. **`eth_sendRawTransaction` + 401**:
   perilaku lama (failover) tidak berubah.
5. **4xx dengan body JSON-RPC valid**: perilaku tidak berubah — domain error
   diteruskan final, capability mismatch tetap regroup, termasuk amplop tunggal
   dengan `id: null` dan amplop tanpa `id`.
6. **Kasus lama tidak berubah**: 429, 5xx, transport error, campuran dengan
   `server_error` (jalur `sick` menang) — seluruh test lama lulus tanpa
   pengecualian yang dibisukan.
7. `bun run check` lulus penuh sebelum commit.

---

## Pertanyaan terbuka

- **Nama kode `-32008`**: tabel kode proxy sekarang berhenti di `-32007`
  (`-32000`…`-32005` proxy, `-32006`, `-32007`). `-32008` melanjutkan rentang itu;
  alternatifnya memakai `-32000` (kode internal umum). Usulan: `-32008`, karena
  maknanya berbeda dari `-32000` "unauthorized/internal proxy" dan operator
  menyaring berdasarkan kode. Perlu dicatat: dengan cakupan 401/403, `-32008`
  menutup makna yang sebelumnya dilipat ke `-32000`/`-32006` untuk kasus key
  ditolak upstream.
- **Teks `message` `-32008`**: usulan "upstream is misconfigured". Kalau reviewer
  ingin bahasa lain, cukup ganti satu konstanta.

Tidak ada pertanyaan desain lain; sisanya mekanis.

---

## Langkah selanjutnya

1. Setelah disetujui: implementasikan sesuai proposal ini (core dulu, lalu router
   dan tabel kode error), dengan test pada bagian Validasi.
2. Perbarui bagian *Penanganan error*, *Kesehatan dua level*, dan tabel kode
   proxy dalam perubahan yang sama.
3. `bun run check` lulus penuh, lalu pindahkan proposal ini ke folder proposal
   terimplementasi dan commit.
