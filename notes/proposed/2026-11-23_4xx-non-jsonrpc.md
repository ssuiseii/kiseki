# 4xx non-JSON-RPC: masalah konfigurasi, bukan kesehatan

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
masalah kapasitas.

Yang diusulkan:

1. `classifyResponse` memilah 4xx non-JSON-RPC ke kelas baru **`misconfigured`**:
   gateway upstream menolak panggilan di luar proses JSON-RPC. Kelas `client_error`
   tetap ada untuk 4xx yang body-nya amplop JSON-RPC sah.
2. Pool menangani `misconfigured` sebagai **kegagalan upstream ini, bukan
   kesehatan**: failover ke key berikutnya, tanpa cooldown key, tanpa parkir
   provider, dan dengan label outcome sendiri untuk log/metrik.
3. Outcome baru di taksonomi, `{ kind: "misconfigured" }`, dan kode error proxy
   baru **`-32008`** agar klien dan operator dapat membedakan masalah konfigurasi
   dari masalah kapasitas: respons akhirnya adalah HTTP `200` + `-32008`, bukan
   `429` + `-32006`.
4. Untuk `eth_sendRawTransaction`, **tidak ada perubahan**: karena catatan riset
   tidak menyatakan apakah penolakan gateway terjadi sebelum request sampai ke
   node, hasilnya tetap `ambiguous` (`-32007`, menghentikan kedua level).

Yang diminta dari reviewer: persetujuan atas kelas klasifikasi baru, outcome baru,
kode error `-32008`, dan kebijakan pool "misconfigured ≠ sakit".

---

## Masalah

Catatan riset *Ankr Advanced API* (bagian "apikey salah") mendokumentasikan,
TERUKUR di kedua endpoint Ankr: apikey yang salah dijawab gateway dengan
**HTTP 404 dan body HTML nginx** (`content-type: text/html`, bukan JSON sama
sekali), bukan balasan JSON-RPC.

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

Dua kesalahan diagnosis yang dihasilkan (keduanya tercatat di catatan riset):

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

- Respons 4xx non-JSON-RPC tidak lagi memicu penilaian kesehatan (cooldown key,
  parkir provider) dan tidak lagi terlihat klien sebagai `429` / `-32006`.
- Klien dan operator dapat membedakan masalah konfigurasi dari masalah kapasitas
  lewat status HTTP, kode error, log, dan metrik.
- Perilaku untuk 4xx yang body-nya amplop JSON-RPC sah **tidak berubah**.
- Jaminan send-safe tidak berubah.
- Tidak ada aturan khusus satu provider di core.

### Non-tujuan

- Mengubah penanganan 401/403 (`unauthorized`) dan 429 (`rate_limited`): keduanya
  sudah benar dan teruji.
- Mengubah kebijakan kuota: pemotongan tetap terjadi sebelum pengiriman, tanpa
  refund, termasuk untuk attempt yang berujung `misconfigured`.
- Memperkenalkan retry khusus atau mekanisme konfigurasi ulang otomatis.
- Mengubah cara router menghitung `Retry-After` untuk kasus yang sudah ada.

---

## Proposal

### 1. Klasifikasi: `misconfigured` di `classifyResponse`

Aturan, berurutan (status di atas 2xx):

1. `429` → `rate_limited` (tidak berubah).
2. `401` / `403` → `unauthorized` (tidak berubah).
3. `5xx` → `server_error` (tidak berubah).
4. **4xx lain** dipilah dengan satu pengujian murni atas body:
   - Body **bukan amplop JSON-RPC** → kelas baru `{ kind: "misconfigured"; status }`.
     "Amplop JSON-RPC" diuji secara konservatif: body ter-parse sebagai JSON dan
     berbentuk objek tunggal atau array, dengan setiap elemen memuat `id` serta
     `result` atau `error`. Body kosong, HTML, teks biasa, JSON non-JSON-RPC, atau
     JSON yang tidak bisa dipetakan ke amplop → `misconfigured`.
   - Body **amplop JSON-RPC sah** → `client_error` seperti sekarang. Sebagian node
     memang menjawab penolakan sah (mis. `-32602 invalid params`) dengan HTTP 4xx;
     itu jawaban node yang sah dan harus di-parse per item seperti hari ini.
5. `client_error` kehilangan arti "mencoba di tempat lain tidak akan membantu":
   untuk 4xx ber-amplop JSON-RPC, isi body-lah yang menentukan (domain error
   per item, final, tanpa failover) — perilaku yang sudah berlaku dan tetap.

Pengujian body hidup di `result.ts` sebagai fungsi murni tanpa I/O, sehingga
seluruh matriks tetap bisa diuji unit tanpa jaringan. Tidak ada pengait
provider-specific: deteksinya bentuk body, bukan isi string ("nginx", header
`content-type: text/html`), sehingga berlaku untuk Ankr maupun gateway lain.

### 2. Pool: `misconfigured` bukan sinyal kesehatan

Di `tryKey`, kelas `misconfigured` ditangani sebagai cabang sendiri:

- **Tidak ada `markFailure`** — tidak ada cooldown eksponensial pada key.
- **Tidak menambah `crossKeyFailures`** — tidak ikut memarkir provider.
- **Tidak ada `markSuccess`** — panggilan tidak berhasil, kesehatan key tidak
  diubah sama sekali. Kuota yang sudah dipotong tetap hangus.
- Failover ke key berikutnya, seperti `unauthorized`: apikey yang salah tidak
  berarti key lain pada instance yang sama juga salah.
- Label outcome untuk `onKeyAttempt`: **`misconfigured`** (label baru pada
  `kiseki_pool_key_attempts_total`). Log warn menyebut status HTTP dan instance
  saja — **isi body tidak pernah masuk log**, karena body balasan gateway tidak
  dijamin bersih dari rahasia.
- `RetryReason` bertambah `"misconfigured"`, terpisah dari `"server_error"`,
  sehingga loop attempt tidak menyalakan `sawServerFailure`.

Ketika semua key habis: jika ada kegagalan server sungguhan, jalur `sick` yang
lama menang (konservatif, tidak berubah); jika attempt berjalan hanya
`misconfigured` (boleh bercampur `unauthorized` — keduanya penolakan kunci/
gateway), pool mengembalikan outcome baru.

### 3. Taksonomi: outcome baru `{ kind: "misconfigured" }`

`UpstreamOutcome` bertambah satu varian. Router bereaksinya seperti
`rate_limited`/`sick` — upstream ditandai sudah dicoba, loop lanjut ke kandidat
berikutnya (apikey salah di satu upstream tidak berarti upstream lain gagal,
jadi menghentikan routing di sini salah) — tetapi `lastEnd` item menerima alasan
baru, `{ kind: "misconfigured" }`, dan `onAttempt` melaporkan label
`misconfigured` pada `kiseki_upstream_attempts_total`.

### 4. Finalisasi: kode error proxy `-32008`

`EndReason` bertambah `{ kind: "misconfigured" }`. Urutan prioritas di
`finalizeItem` menjadi:

1. mismatch kapabilitas → error provider, verbatim (tidak berubah);
2. **`misconfigured` → error proxy `-32008`**, tanpa flag kapasitas;
3. `sick` → `-32006` (tidak berubah);
4. `rate_limited` → `-32005` (tidak berubah).

Error barunya dibangun di lapisan error proxy (kode `ERROR_UPSTREAM_MISCONFIGURED
= -32008`), misalnya:

```json
{"code": -32008, "message": "upstream rejected the request outside JSON-RPC", "data": {"status": 404}}
```

`data.status` hanya berisi nomor status HTTP. Karena flag kapasitas tidak
di-set, `shapeResponse` menghasilkan **HTTP `200`**, bukan `429`: tidak ada
`Retry-After` yang bisa dijanjikan dengan jujur untuk masalah konfigurasi, dan
aturan eksak §6.4 ("429 hanya bila seluruh item gagal karena kapasitas atau
kesehatan") otomatis terpenuhi.

Semantik "ending terakhir" tetap literal seperti sekarang: `misconfigured` diikuti
`rate_limited` di upstream lain berujung `-32005` — item belum terbukti mustahil,
hanya upstream ini yang bermasalah konfigurasi, dan itu jawaban yang jujur.

### 5. `eth_sendRawTransaction`: tetap ambigu

Catatan riset tidak menyatakan apakah penolakan gateway (HTTP 404 HTML Ankr)
terjadi **sebelum** request sampai ke node. Ada gateway yang mem-forward ke node
dan ada yang tidak; dari luar tidak bisa dibuktikan. Maka:

- Kelas `misconfigured` pada grup `NON_IDEMPOTENT` → `ambiguous` seperti hari
  ini: `-32007`, menghentikan kedua level, tanpa retry.
- Log warn `sendRaw ambiguous` memuat reason `misconfigured` sehingga operator
  yang menyelidiki insiden `-32007` dapat melihat bahwa penolakan itu berbentuk
  4xx non-JSON-RPC (indikasi konfigurasi), tetapi klien tetap menerima `-32007`.

Jaminan send-safe tidak melemah: tidak ada jalur baru yang menyatakan "request
belum sampai ke node" tanpa bukti.

### 6. Apa yang dilihat klien dan operator

| Permukaan | Sebelum | Sesudah |
|---|---|---|
| Klien, READ | `429` + `-32006` "no healthy upstream" | `200` + `-32008` "upstream rejected the request outside JSON-RPC", `data.status` |
| Klien, sendRaw | `-32007` | `-32007` (tidak berubah) |
| Status HTTP respons | `429` + `Retry-After` palsu | `200` |
| Log pool | "upstream failure"/"sendRaw ambiguous" lalu "provider sick" | warn `misconfigured` per key (status HTTP), tanpa parkir provider; sendRaw tetap warn ambiguous |
| Metrik level 2 | `kiseki_pool_key_attempts_total{outcome="bad_body"|"server_error"}` | label baru `outcome="misconfigured"` |
| Metrik level 1 | `kiseki_upstream_attempts_total{outcome="sick"}` | label baru `outcome="misconfigured"` |
| Sinyal kesehatan | provider diparkir 1 s → 60 s | tidak ada parkir; kesehatan tidak tersentuh |

Operator membedakan: `429`/`-32006` dengan parkir provider = masalah kapasitas
atau kesehatan; `200` + `-32008` = periksa konfigurasi apikey/url instance itu.

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
   amplop JSON-RPC bersifat generik dan mencakup semua kasus ini.
4. **Perlakukan penolakan gateway sebagai bukti "belum sampai ke node"** untuk
   sendRaw (varian `reachedNode: false`). Ditolak: catatan riset tidak
   mendokumentasikan itu; invariant 3 (ambiguous menghentikan kedua level) tidak
   boleh melemah tanpa bukti terukur.
5. **Retry diam-diam ke key berikutnya tanpa label/metric baru**. Ditolak:
   menyembunyikan masalah; operator tidak mendapat sinyal apa pun dan kegagalan
   konfigurasi kembali menyamar.
6. **Serahkan klasifikasi ke paket provider** lewat hook. Ditolak: klasifikasi
   HTTP adalah tugas core; paket provider tidak boleh memuat klasifikasi HTTP
   (tabel tanggung jawab dalam pedoman repositori), dan aturan ini bukan
   kekhususan Ankr.

---

## Prinsip yang dipertahankan

- Kuota dipotong sebelum request dikirim, sekali per attempt, tanpa refund —
  attempt `misconfigured` juga membayar (invariant 1).
- Tidak ada antrean; `429` hanya untuk kegagalan kapasitas/kesehatan (invariant 2
  dan 10 — `misconfigured` bukan keduanya, jadi tidak pernah memicu `429`).
- `eth_sendRawTransaction` ambigu menghentikan kedua level (invariant 3).
- Passthrough menang atas penemuan: jawaban node sah (termasuk 4xx ber-amplop
  JSON-RPC) tidak diubah dan tidak di-retry.
- Token tidak pernah muncul di log, metrik, pesan error, atau respons
  (invariant 11) — isi body balasan gateway tidak pernah dicatat.
- Core tetap tanpa aturan provider; paket provider tetap tanpa klasifikasi HTTP.
- Router tetap tidak menyentuh bucket; ia hanya bereaksi terhadap `kind`.

---

## Dampak

- **`upstream-core`**: `result.ts` (kelas `misconfigured` + uji amplop JSON-RPC),
  `pool.ts` (cabang `misconfigured`, `RetryReason` baru), `types/outcome.ts`
  (varian outcome baru). Kontrak `UpstreamAdapter` tidak berubah bentuk — hanya
  nilai `kind` yang bertambah, dan router memang sudah generik terhadap `kind`.
- **`kiseki`**: `errors.ts` (kode `-32008`), `router/index.ts` (`EndReason` baru,
  reaksi outcome, finalisasi), tanpa perubahan server/pipeline — `shapeResponse`
  sudah benar karena flag kapasitas tidak di-set.
- **Dokumentasi**: bagian *Penanganan error* (tabel reaksi outcome, tabel kode
  error proxy, aturan status HTTP), *Kesehatan dua level* (baris untuk
  `misconfigured`), dan daftar *Invarian* tetap konsisten tanpa perubahan teks
  invariant — diperbarui dalam perubahan implementasi yang sama.
- **Metrik**: dua label baru pada counter yang sudah ada; tidak ada metrik baru.
- **Kompatibilitas**: tidak ada perubahan konfigurasi, tidak ada perubahan wire
  format request klien.

---

## Risiko dan mitigasi

1. **Gateway menjawab 4xx dengan amplop JSON-RPC yang bukan jawaban node**
   (mis. salinan bentuk JSON-RPC untuk error autentikasi). Mitigasi: 401/403 dan
   429 disaring lebih dulu; sisanya diparse per item dan error diteruskan
   verbatim — jawaban yang salah tetap tidak memicu retry, hanya tidak final
   bila cocok matcher kapabilitas. Risiko diketahui dan diterima: perilaku ini
   identik dengan yang sudah berlaku untuk `client_error` hari ini.
2. **Salah klasifikasi pada body JSON yang tidak konvensional** (mis. amplop
   tanpa `id`). Mitigasi: uji amplop konservatif — body tanpa `id` + (`result`
   atau `error`) jatuh ke `misconfigured`, yang konsekuensinya hanya "coba
   upstream lain, jangan nilai kesehatan", bukan jawaban palsu ke klien.
3. **Batch campuran: sebagian item sudah terjawab di attempt sebelumnya pada
   request yang sama.** Mitigasi: outcome `misconfigured` hanya menyentuh item
   yang belum terjawab, sama seperti reaksi `rate_limited`/`sick` sekarang.
4. **Insiden `-32007` menjadi lebih sulit dihubungkan dengan akar konfigurasi**
   karena klien tidak melihat perbedaannya. Mitigasi: log warn `sendRaw
   ambiguous` memuat reason `misconfigured`, dan metrik level-2 memakai label
   `misconfigured`, sehingga operator tetap bisa menelusurinya.

---

## Validasi

Semua test memakai harness injeksi (`fetchImpl` palsu, `now()` statis) tanpa
jaringan, dan body HTML dikutip verbatim dari catatan riset *Ankr Advanced API*:

1. **READ, 4xx non-JSON-RPC** (HTML 404 nginx): tidak ada cooldown key, tidak ada
   penambahan `crossKeyFailures`, provider tidak sakit; failover ke key berikutnya;
   saat key habis, outcome `misconfigured` kembali ke router.
2. **Router, kasus end-to-end**: satu upstream `misconfigured` + satu upstream
   sehat → item terjawab oleh upstream sehat; semua upstream `misconfigured` →
   klien menerima `-32008` dengan HTTP `200` dan tanpa `Retry-After`.
3. **`eth_sendRawTransaction` + 4xx non-JSON-RPC**: outcome `ambiguous`, `-32007`,
   kedua level berhenti; tidak ada retry.
4. **4xx dengan amplop JSON-RPC valid**: perilaku tidak berubah — domain error
   diteruskan final, capability mismatch tetap regroup.
5. **Kasus lama tidak berubah**: 429, 401/403, 5xx, transport error, campuran
   `misconfigured` + `server_error` (jalur `sick` menang) — seluruh test lama
   lulus tanpa pengecualian yang dibisukan.
6. `bun run check` lulus penuh sebelum commit.

---

## Pertanyaan terbuka

- **Nama kode `-32008`**: tabel kode proxy sekarang berhenti di `-32007`
  (`-32000`…`-32005` proxy, `-32006`, `-32007`). `-32008` melanjutkan rentang itu;
  alternatifnya memakai `-32000` (kode internal umum). Usulan: `-32008`, karena
  maknanya berbeda dari `-32000` "unauthorized/internal proxy" dan operator
  menyaring berdasarkan kode.
- **Teks `message` `-32008`**: usulan "upstream rejected the request outside
  JSON-RPC". Kalau reviewer ingin bahasa lain, cukup ganti satu konstanta.

Tidak ada pertanyaan desain lain; sisanya mekanis.

---

## Langkah selanjutnya

1. Setelah disetujui: implementasikan sesuai proposal ini (core dulu, lalu router
   dan tabel kode error), dengan test pada bagian Validasi.
2. Perbarui bagian *Penanganan error*, *Kesehatan dua level*, dan tabel kode
   proxy dalam perubahan yang sama.
3. `bun run check` lulus penuh, lalu pindahkan proposal ini ke folder proposal
   terimplementasi dan commit.
