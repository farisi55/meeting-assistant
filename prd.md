---
doc_id: PRD-MEETING-ASSISTANT-001
version: 1.0.2
status: draft
created: 2026-09-23
flow_compatibility: vibe-coding-v1.7
project_shape: fullstack
---

# meeting-assistant — Product Requirements Document

## 1. Executive Summary
- **Project Shape:** fullstack
- **Problem:** Freelancer/remote developer non-native English speaker kesulitan
  berkomunikasi lancar secara real-time saat meeting dengan klien asing atau
  interview kerja, sementara tool sejenis yang ada (mis. Karya AI) mengharuskan
  instalasi executable yang tidak tepercaya dan mendorong penggunaan yang
  tersembunyi dari pihak lawan bicara.
- **Solution:** Asisten berbasis browser yang menangkap audio meeting langsung
  (mic + audio sistem), mentranskrip dan menerjemahkan real-time, serta
  membantu merangkai respons dari poin-poin milik pengguna sendiri — tanpa
  instalasi tambahan, berjalan sepenuhnya di infrastruktur gratis.
- **Success metric:** Nol biaya operasional bulanan, sambil tetap dipakai
  aktif (≥1x/minggu) pada meeting/interview nyata selama 3 bulan pertama.
- **MVP deadline:** not specified

## 2. Users & Context
- **Primary users:** Banu (solo developer/freelancer, non-native English
  speaker)
- **User goal:** Berkomunikasi efektif dalam Bahasa Inggris saat meeting
  klien asing, dan berlatih interview kerja tanpa tekanan real-time
- **Current pain:** Tool sejenis (Karya AI) berupa installer .exe yang
  terdeteksi sebagai virus, model bisnis berbayar/subscription, dan didesain
  agar tersembunyi dari pihak lawan bicara
- **Environment:** Browser desktop, Chrome/Edge diprioritaskan — [ASSUMED]
  audio sistem via `getDisplayMedia` hanya diteruskan penuh di
  Chromium-based browser (Windows/Linux/ChromeOS); Firefox/Safari tidak
  meneruskan audio lewat jalur ini
- **External API consumers:** none

## 3. Scope

### 3.1 In-Scope Features
| Feature | Priority | Description |
|---|---|---|
| Audio capture (mic + audio sistem) | P0 — MVP | `getUserMedia` + `getDisplayMedia`, tanpa instalasi tambahan |
| Transkripsi + terjemahan real-time | P0 — MVP | Via Groq Whisper, Indonesia ↔ Inggris |
| Multi-provider LLM routing + fallback | P0 — MVP | OpenRouter → Groq → Mistral (SambaNova sementara keluar — free tier minta billing); sudah diimplementasikan |
| Auth toggle | P0 — MVP | Basic Auth aktif hanya saat deployment publik; sudah diimplementasikan |
| Bantu merangkai respons ("Steer AI") | P1 | User supply poin kasar, AI rapikan jadi kalimat fasih |
| Upload konteks (CV/JD/product knowledge) | P1 | Personalisasi jawaban per mode |
| Mode latihan interview | P2 | Praktik + feedback setelah sesi, bukan live-read |

### 3.2 Out of Scope (explicit)
- Live verbatim AI-answer yang dibaca langsung saat interview kerja
  sungguhan (menyamarkan kemampuan asli kandidat ke pewawancara)
- Fitur overlay/anti-deteksi yang menyembunyikan pemakaian AI dari peserta
  meeting lain (screen-share, recording)
- Model/tier berbayar apa pun
- Multi-user / akun terpisah / billing (personal use only)
- Aplikasi desktop terinstal (.exe/.dmg) — tetap browser-based

### 3.3 Future Considerations
- Riwayat transkrip persisten via Workers KV/D1 (saat ini disengaja "none")
- Cloudflare Access sebagai lapis auth tambahan di samping Basic Auth
- Streaming response (SSE) begitu satu provider utama sudah stabil dipilih
- Whisper lokal via WASM sebagai alternatif STT tanpa dependency eksternal
- Dukungan menangkap beberapa sumber audio/tab sekaligus

## 4. Technical Specification

### 4.1 Tech Stack
- **Language & Runtime:** JavaScript (ES2022+) — Cloudflare Workers runtime
  (V8 isolate) untuk backend; browser-native ES modules untuk frontend
- **Framework:** Tidak ada framework backend (native Workers `fetch`
  handler). Frontend: vanilla JS tanpa build step — **diputuskan**, tidak
  pakai Alpine.js/Preact
- **Database:** none untuk data aplikasi. Workers KV dipakai secara
  terbatas untuk counter lockout Basic Auth (§6.2) — bukan database
  aplikasi, tidak menyimpan entity/data pengguna
- **ORM / Query builder:** omit (no database aplikasi)
- **Cache:** none — [ASSUMED] tidak ada data server-side yang perlu di-cache
- **Infrastructure:** Cloudflare Workers (serverless, free plan)
- **Container orchestration:** none
- **Key third-party services:** OpenRouter, Groq, Mistral (La Plateforme),
  SambaNova Cloud
- **Webhook providers:** none — semua panggilan outbound, tidak ada callback
  masuk
- **Frontend framework (if applicable):** none / vanilla JS

### 4.2 Architecture
- **Pattern:** Serverless — satu Cloudflare Worker melayani static assets +
  API routes sekaligus
- **Module structure:**
  ```
  project-root/
  ├── worker.js            # Backend: auth, routing, provider fallback
  ├── wrangler.toml         # Config Cloudflare Workers + vars
  ├── .dev.vars              # Secret lokal (gitignored)
  ├── .gitignore
  ├── public/                # Frontend statis, di-serve oleh Worker
  │   ├── index.html
  │   ├── app.js               # Entry point UI
  │   ├── config.js             # Konstanta konfigurasi (mis. MAX_CONTEXT_CHARS)
  │   ├── audio-capture.js      # getUserMedia + getDisplayMedia + chunking
  │   ├── providers.js           # Helper client utk /api/chat, /api/transcribe
  │   └── styles.css
  ├── test/                   # Vitest + vitest-pool-workers
  │   └── worker.test.js
  └── prd.md / knowledge.md / changelog.md   # Dokumen pipeline
  ```
- **Key design patterns:** Provider fallback chain (mirip Chain of
  Responsibility) untuk routing LLM; stateless request/response, tidak ada
  session server-side di luar header Basic Auth per-request
- **Data flow:** Browser (capture audio) → chunk → `POST /api/transcribe`
  (Worker → Groq) → transcript → client rakit prompt (system: persona/CV/JD,
  user: transcript) → `POST /api/chat` (Worker → provider fallback chain) →
  response ditampilkan di UI
- **Key architectural decisions:**
  - Cloudflare Workers over VPS/Node server tradisional — memenuhi hard
    constraint 100% gratis tanpa mengorbankan opsi jalan lokal (`wrangler dev`
    membaca `.dev.vars` persis seperti `.env`)
  - Provider fallback chain (4 LLM gratis) over top-up credit OpenRouter —
    mengatasi limit 50 request/hari tanpa biaya, sesuai hard constraint gratis
  - Non-streaming response (chat) over SSE streaming — status tiap provider
    perlu dicek sebelum pindah ke provider berikutnya dalam fallback chain;
    trade-off: UI tidak menampilkan token secara live
  - Client-side state (localStorage/IndexedDB) over server-side database —
    sesuai constraint kesederhanaan personal-use, sekaligus menghindari
    kebutuhan backup/RPO server
  - Basic Auth toggle via env var over Cloudflare Access sebagai default —
    memenuhi permintaan literal "username+password"; Access tetap tersedia
    sebagai opsi lapis tambahan
  - Response envelope passthrough over standarisasi {data,error,meta} —
    lebih sederhana untuk single consumer internal, tidak ada kontrak API
    eksternal yang perlu dijaga stabil

### 4.3 Code Standards
- **Naming — files:** kebab-case
- **Naming — functions:** camelCase
- **Naming — classes/types:** PascalCase
- **Formatter:** Prettier
- **Linter:** ESLint (config dasar, plain JS — bukan @typescript-eslint)
- **Testing framework:** Vitest + `@cloudflare/vitest-pool-workers` —
  **diputuskan**
- **Test coverage target:** [ASSUMED] tidak ada target formal untuk MVP
  personal-use; fokus manual + unit test tiap jalur fallback provider
- **Error handling:** try/catch di level handler (`handleChat`,
  `handleTranscribe`), status HTTP diteruskan apa adanya dari upstream

### 4.4 API Design
- **API type:** REST (2 endpoint sederhana, bukan resource-based penuh)
- **Base URL pattern:** `/api/` — [ASSUMED] tidak di-versioning karena
  konsumen internal tunggal
- **Authentication method:** HTTP Basic Auth, toggle via env var
  `AUTH_ENABLED` (bukan JWT — sesuai permintaan literal username+password)
- **Response envelope:** Passthrough dari response provider upstream
  (bentuk OpenAI-compatible: `{choices, usage, ...}`) + field `_provider`
  penanda provider yang berhasil menjawab — **diputuskan**, tidak dibungkus
  format standar `{data,error,meta}`
- **Error format:** Status HTTP + body upstream provider diteruskan apa
  adanya — [ASSUMED] cukup untuk debugging single-user, belum perlu
  `request_id`/format error custom
- **Pagination:** none
- **API versioning strategy:** none
- **Backward compatibility policy:** omit — tidak ada konsumen eksternal
- **Rate limiting store:** none — single instance/single user; rate limit
  justru terjadi di sisi provider (OpenRouter dkk), bukan di Worker ini
- **Webhook inbound verification:** none

### 4.5 Data Model
*(Omitted — §4.1 Database: none)*

### 4.6 Brand & Visual Identity
- **Color palette:** TBD — [ASSUMED] belum dibahas; fungsi diprioritaskan
  dulu dibanding desain
- **Typography:** [ASSUMED] system-ui font stack browser sebagai starting
  point
- **Brand voice / tone:** n/a — tool personal, tidak ada audiens eksternal
- **Visual direction:** [ASSUMED] minimal, fungsional, dark mode — cocok
  untuk overlay yang dilihat saat meeting berlangsung tanpa mengganggu
- **Existing brand guide:** none — define during design phase
- **Scale note:** tidak relevan untuk skala proyek ini, tidak perlu
  design-tokens.md terpisah

## 5. Feature Specifications

### Feature: Audio Capture (Mic + Audio Sistem)
- **User story:** Sebagai pengguna, saya ingin menangkap audio mic saya dan
  audio sistem (suara lawan bicara) sekaligus, supaya kedua sisi percakapan
  bisa diproses tanpa instalasi software tambahan.
- **Acceptance criteria:**
  - [ ] `getUserMedia()` berhasil menangkap audio mic dengan izin browser
        standar
  - [ ] `getDisplayMedia({video:true, audio:true})` berhasil menangkap audio
        tab/sistem saat user memilih share dengan audio dicentang
  - [ ] Sistem memberi peringatan jelas kalau audio track tidak ada di
        stream (user lupa centang share audio)
  - [ ] Event `ended` pada track ditangani — UI memberi tahu sesi capture
        berhenti dan menawarkan mulai ulang
- **Business rules:** Audio sistem hanya berfungsi penuh di Chrome/Edge
  (Windows/Linux/ChromeOS untuk tab & seluruh layar; macOS hanya audio tab);
  Firefox/Safari tidak meneruskan audio lewat `getDisplayMedia`
- **UI notes:** Tombol terpisah "Mulai rekam mic" dan "Bagikan audio
  meeting", indikator status tiap stream
- **Priority:** P0

### Feature: Transkripsi + Terjemahan Real-Time
- **User story:** Sebagai pengguna, saya ingin ucapan lawan bicara
  ditranskrip dan diterjemahkan ke Bahasa Indonesia near-real-time, supaya
  saya bisa mengikuti percakapan tanpa hambatan bahasa.
- **Acceptance criteria:**
  - [ ] Audio dari `getDisplayMedia` di-chunk (jeda bicara terdeteksi, atau
        interval tetap 4–8 detik) dan dikirim ke `POST /api/transcribe`
  - [ ] Worker meneruskan chunk ke Groq Whisper, transkrip bahasa asal
        tampil di UI dalam <5 detik dari akhir ucapan
  - [ ] Transkrip diteruskan ke LLM untuk terjemahan/ringkasan sesuai mode
        aktif
- **Business rules:** Bahasa target default "id", bisa diganti per sesi;
  ukuran chunk dibatasi sesuai limit upload Groq (25MB/file)
- **UI notes:** Panel transkrip live, auto-scroll, bisa di-pause
- **Priority:** P0

### Feature: Multi-Provider LLM Routing + Fallback
- **User story:** Sebagai pengguna, saya ingin permintaan ke AI otomatis
  pindah ke provider gratis lain kalau satu provider kena limit, supaya
  asisten tetap bisa dipakai sepanjang hari tanpa biaya.
- **Acceptance criteria:**
  - [x] Worker mencoba provider sesuai `FALLBACK_ORDER` (OpenRouter → Groq →
        Mistral; SambaNova sementara di luar rantai karena free tier-nya
        kini menuntut billing/402), lanjut ke provider berikutnya kalau
        respons non-2xx
  - [x] Provider tanpa API key ter-set dilewati otomatis tanpa error
  - [x] Client bisa memaksa satu provider spesifik lewat field `provider`
  - [x] Response menyertakan metadata `_provider` supaya UI bisa
        menampilkan provider yang menjawab
- **Business rules:** Urutan fallback dan model default per provider
  dikonfigurasi di satu tempat (objek `PROVIDERS` di `worker.js`)
- **UI notes:** Indikator kecil provider yang sedang menjawab (opsional,
  untuk debugging)
- **Priority:** P0
- *Catatan: backend fitur ini sudah diimplementasikan di sesi sebelumnya —
  checklist mencerminkan status tersebut.*

### Feature: Auth Toggle
- **User story:** Sebagai pengguna, saya ingin aplikasi otomatis meminta
  login saat diakses lewat domain publik, tapi berjalan bebas tanpa login
  saat dijalankan lokal, tanpa perlu ubah kode antar mode.
- **Acceptance criteria:**
  - [x] `AUTH_ENABLED=false` (default di `.dev.vars` lokal) → semua request
        lolos tanpa cek kredensial
  - [x] `AUTH_ENABLED=true` (deployment publik) → request tanpa header
        Basic Auth valid ditolak dengan 401
  - [x] `run_worker_first: true` memastikan proteksi berlaku juga untuk
        frontend statis, bukan cuma `/api/*`
  - [x] 3x percobaan kredensial salah dari IP yang sama -> permintaan
        berikutnya ditolak 429 sampai 15 menit berlalu (KV TTL), walau
        kredensial yang dikirim sudah benar
  - [x] Percobaan tanpa header Authorization (page load awal) tidak
        dihitung sebagai kegagalan; login berhasil mereset counter
- **Business rules:** Kredensial disimpan sebagai Wrangler secret
  terenkripsi, tidak pernah di kode/repo. Lockout fail-open tanpa
  binding `AUTH_KV` (auth tetap jalan, cuma tanpa proteksi brute-force)
- **UI notes:** Browser native Basic Auth prompt, tidak perlu form login
  custom
- **Priority:** P0
- *Catatan: sudah diimplementasikan.*

### Feature: Bantuan Merangkai Respons ("Steer AI"-style)
- **User story:** Sebagai pengguna, saya ingin mengetik poin kasar dan AI
  merapikannya jadi kalimat Inggris yang fasih, supaya substansi jawaban
  tetap murni dari saya sendiri.
- **Acceptance criteria:**
  - [ ] Input bebas dari user dikirim sebagai user message ke `/api/chat`
        dengan system prompt yang secara eksplisit menginstruksikan AI
        HANYA merapikan bahasa, tidak menambah klaim/fakta baru
  - [ ] Output ditampilkan sebagai teks siap salin, dengan indikasi jelas
        ini hasil olahan AI dari poin milik user
  - [ ] Mode ini tersedia di semua konteks (meeting klien maupun interview)
- **Business rules:** System prompt mode ini wajib melarang penambahan
  informasi/klaim yang tidak ada di input user — lihat §3.2 Out of Scope
- **UI notes:** Textarea poin kasar + tombol "Rapikan", area hasil dengan
  tombol salin
- **Priority:** P1

### Feature: Upload Konteks (CV, Job Description, Product Knowledge)
- **User story:** Sebagai pengguna, saya ingin mengunggah CV, job
  description, atau product knowledge sekali di awal sesi, supaya AI
  memberi respons relevan sepanjang sesi.
- **Acceptance criteria:**
  - [ ] User bisa upload/paste teks yang disimpan di
        localStorage/IndexedDB browser
  - [ ] Konten otomatis disisipkan ke system prompt setiap panggilan
        `/api/chat` selama mode terkait aktif
  - [ ] User bisa mengganti/menghapus konteks kapan saja tanpa reload
  - [ ] Input konteks dibatasi 5.000 karakter per field (CV, JD, product
        knowledge masing-masing), dengan pesan validasi jika terlampaui
- **Business rules:** Batas 5.000 karakter per field adalah default yang
  dibaca dari `config.js` (`MAX_CONTEXT_CHARS`) — **diputuskan**,
  configurable tanpa perlu ubah logic lain
- **UI notes:** Panel upload terpisah per mode (CV+JD untuk interview,
  product knowledge untuk sales/meeting), penghitung karakter real-time
- **Priority:** P1

### Feature: Mode Latihan Interview
- **User story:** Sebagai pengguna, saya ingin berlatih menjawab pertanyaan
  interview kerja Bahasa Inggris dan menerima feedback SETELAH sesi selesai,
  supaya saya lebih percaya diri di interview sungguhan tanpa bergantung
  pada bantuan real-time yang tersembunyi.
- **Acceptance criteria:**
  - [ ] AI mengajukan pertanyaan interview berdasarkan CV+JD yang diupload,
        satu per satu
  - [ ] User menjawab (lisan via mic, ditranskrip, atau tertulis)
  - [ ] Feedback (kejelasan, relevansi, saran bahasa) HANYA tampil setelah
        user menandai jawaban selesai — bukan real-time selama menjawab
- **Business rules:** Mode ini secara desain TIDAK menyediakan jawaban yang
  dibaca langsung — lihat §3.2 Out of Scope. AI berperan sebagai pewawancara
  + coach, bukan sumber jawaban.
- **UI notes:** Flow terpisah dari mode "meeting klien" — layar
  tanya-jawab-feedback, bukan overlay live
- **Priority:** P2

## 6. Non-Functional Requirements

### 6.1 Performance & Scale
- Response time target: [ASSUMED] end-to-end (ucapan berhenti → transkrip
  tampil) <5 detik; `/api/chat` <8 detik termasuk potensi 1x fallback
- Concurrent users / usage volume (initial): 1
- Concurrent users / usage volume (6-month target): 1 → **Simple Mode
  berlaku**

### 6.2 Security
- Auth standard: HTTP Basic Auth (browser native), toggle via
  `AUTH_ENABLED` — bukan JWT
- JWT algorithm: omit (tidak dipakai)
- Password hashing: Perbandingan plaintext string (`===`) dari Wrangler
  secret — **diputuskan**, cukup untuk single-credential Basic Auth
  tanpa tabel user pada skala personal-use ini
- PII handling: Transkrip berpotensi memuat info pribadi (nama, detail
  pekerjaan) — [ASSUMED] tidak disimpan permanen di server (selaras dengan
  §4.1 Database: none), hanya diproses in-flight
- Error tracking PII policy: Tidak ada tool tracking terpisah (§6.5), tapi
  isi transkrip/percakapan tidak boleh di-log ke `wrangler tail` dalam
  kondisi produksi — log itu terbaca siapa pun dengan akses dashboard
- Session: omit — Basic Auth diverifikasi ulang tiap request
- Brute force protection: **Diputuskan** — lockout sederhana, maksimal 3
  percobaan gagal per IP (`CF-Connecting-IP`), disimpan di Workers KV
  (`AUTH_KV`) dengan `expirationTtl` 15 menit sehingga otomatis reset
  tanpa intervensi manual. Percobaan pertama tanpa header Authorization
  (page load awal) tidak dihitung sebagai kegagalan — hanya kredensial
  salah yang dihitung. Login berhasil menghapus counter. Tanpa binding
  `AUTH_KV`, auth tetap berfungsi tapi tanpa proteksi ini (fail-open by
  design, bukan fail-closed, supaya tidak memblokir MVP kalau KV belum
  di-setup).
- Secret rotation strategy: Manual via `wrangler secret put` ulang
  (overwrite), tidak ada otomasi

### 6.3 Scalability
- Growth expectation: Tidak ada — personal use, tidak direncanakan tumbuh
- Scaling strategy: Serverless auto-scale bawaan Cloudflare Workers, tidak
  perlu dikonfigurasi manual
- Caching: none
- DB scaling: omit (no database)

### 6.4 Compliance
- Standards: not applicable
- Regulations: none — [ASSUMED] personal use, transkrip tidak disimpan
  permanen, tidak ada pengumpulan data pihak ketiga secara sistematis.
  Catatan: kalau nanti dipakai untuk meeting yang melibatkan data pribadi
  klien, UU PDP tetap relevan secara etis meski bukan requirement formal
  untuk proyek personal ini.

### 6.5 Observability
- **Logging:** `wrangler tail` / Cloudflare dashboard Logs — real-time,
  tanpa structured JSON formal untuk MVP
- **Log levels:** [ASSUMED] tidak dibedakan dev/prod untuk skala ini
- **Error tracking / crash reporting:** none untuk MVP
- **Metrics:** none
- **Alerting:** none
- **Health endpoints:** Tidak diperlukan — **diputuskan**

## 7. Environment & Configuration
- **Environments:** dev (`wrangler dev` + `.dev.vars`) / prod (`wrangler
  deploy` + secrets) — [ASSUMED] tidak ada staging terpisah untuk skala ini
- **Required env vars (names only):** `AUTH_ENABLED`, `BASIC_AUTH_USER`,
  `BASIC_AUTH_PASS`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`,
  `MISTRAL_API_KEY`, `SAMBANOVA_API_KEY`, `PUBLIC_URL`
- **Required bindings (non-secret):** KV namespace `AUTH_KV` (lockout
  counter) — buat via `wrangler kv namespace create AUTH_KV`, opsional
  tapi direkomendasikan di deployment publik
- **Feature flags:** none
- **CI/CD:** `wrangler deploy` manual dari terminal — **diputuskan**,
  tanpa pipeline CI formal
- **CI secret masking:** omit (tidak ada CI — dikonfirmasi)
- **Container secret handling:** omit (bukan containerized)
- **Deployment / distribution command:** `wrangler deploy`
- **Application versioning strategy:** [ASSUMED] semver manual, tidak strict
- **Version tag/build-number format:** [ASSUMED] `vX.Y.Z`, tag manual saat
  rilis signifikan
- **Release trigger:** Manual (`wrangler deploy` dijalankan langsung)
- **Backup strategy:** Tidak ada database untuk dibackup — cukup source
  code di git
- **Backup retention:** omit (no database)
- **RTO / RPO:** omit (no database) — level project: menitan, redeploy dari
  git
- **Rollback / update-channel strategy:** Redeploy git tag/commit
  sebelumnya via `wrangler deploy`

## 8. Constraints & Anti-patterns

### Technical Constraints
- Harus berjalan di Cloudflare Workers — tidak ada akses `fs`/`net` Node
  native, hanya Web API standar + Workers-specific API
- Audio sistem via `getDisplayMedia` hanya stabil penuh di Chrome/Edge
  (lihat §2 Environment)

### Forbidden Patterns
- No raw SQL — n/a (no database)
- No `any` type — n/a (plain JavaScript untuk MVP; berlaku kalau nanti
  migrasi ke TypeScript)
- No sync I/O di request handler — semua panggilan provider wajib
  async/await via `fetch()`
- No `console.log` isi transkrip/percakapan lengkap di production
  (lihat §6.2 PII)
- No hard delete — n/a (tidak ada entity tersimpan)
- No redirect ke URL dari input user tanpa validasi — berlaku kalau nanti
  ada fitur share link
- No unverified inbound webhook — n/a (tidak ada webhook masuk)
- No API key provider ditulis langsung di kode/`wrangler.toml [vars]` —
  wajib lewat `wrangler secret put` atau `.dev.vars` (gitignored)
- No lockout state yang tidak auto-reset — wajib pakai `expirationTtl`
  KV, supaya tidak ada risiko Banu mengunci dirinya sendiri permanen
- No input konteks (CV/JD/product knowledge) melebihi 5.000 karakter per
  field tanpa validasi di sisi client

### Known Third-Party Limitations
- OpenRouter model `:free`: 20 request/menit; 50/hari (belum pernah beli
  credit) atau 1.000/hari (pernah beli ≥10 credit sekali)
- Groq: chat 20 request/menit & 2.000/hari; Whisper 20 request/menit,
  2.000/hari, ±8 jam audio/hari
- Mistral La Plateforme: free tier tersedia, limit persis bervariasi
  (~1 request/detik) — cek dashboard langsung
- SambaNova Cloud: free tier tanpa kartu kredit, limit request belum
  diverifikasi presisi — cek dashboard langsung

### Security Hard Rules
- No secrets di source code — hanya lewat `.dev.vars` (gitignored) atau
  `wrangler secret`
- CORS: n/a untuk MVP (frontend & API satu origin, tidak ada cross-origin
  request)

## 9. Development Phases

| Phase | Name | Focus | Berlaku untuk proyek ini? |
|---|---|---|---|
| Phase 1 | Foundation | Scaffolding, CI/CD, logging init, health endpoint, env var validation | Ya (health endpoint dikecualikan — lihat §6.5) |
| Phase 2 | Domain & Data | Models, migrasi, soft-delete | **Tidak** — §4.1 Database: none |
| Phase 3 | Core Features | Fitur P0 + unit test (Vitest) + API backward-compatible | Ya |
| Phase 4 | Integration | OpenRouter/Groq/Mistral/SambaNova + fallback (tanpa webhook signature — tidak ada webhook masuk) | Ya |
| Phase 5 | UI/UX | Screens/components (vanilla JS) + XSS/output encoding | Ya — shape fullstack, ada UI |
| Phase 6 | Testing & QA | Vitest + vitest-pool-workers, integration test jalur fallback | Ya, skala disesuaikan personal-use |
| Phase 7 | Deployment | Cloudflare Workers, `wrangler deploy` | Ya, varian ringan — skip canary/staged rollout (§6.1 target 6 bulan = 1, jauh di bawah 1.000) |

## 10. Open Questions

Tidak ada open question tersisa — semua 9 item (6 di v1.0.1, 3 di v1.0.2)
sudah diputuskan dan masuk ke bagian terkait di atas; lihat §11 Revision
History untuk riwayat lengkap.

## 11. Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0.0 | 2026-09-23 | Banu (AI-assisted draft, via Claude) | Initial draft dari developer's brief |
| 1.0.1 | 2026-09-23 | Banu (AI-assisted draft, via Claude) | Nama proyek difinalkan (meeting-assistant); 5 Open Questions diputuskan (frontend, testing, response envelope, batas konteks, health endpoint); 2 item baru dipromosikan ke Open Questions (password/credential comparison, brute force protection) yang sebelumnya ter-tag [DECISION NEEDED] di §6.2 tapi belum sempat ditanyakan; CI/CD juga baru dipromosikan dari §7 |
| 1.0.2 | 2026-09-23 | Banu (AI-assisted draft, via Claude) | 3 Open Questions terakhir diputuskan: kredensial tetap plaintext `===`; lockout ditambahkan (maks 3 percobaan gagal/IP, Workers KV `AUTH_KV`, TTL 15 menit, fail-open tanpa binding); CI/CD tetap manual. §4.1 Database diklarifikasi (KV dipakai terbatas untuk lockout, bukan database aplikasi). Implementasi lockout masuk ke worker.js + wrangler.toml. Tidak ada Open Questions tersisa. |
