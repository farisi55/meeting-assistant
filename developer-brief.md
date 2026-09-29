PROJECT SHAPE: fullstack
  (satu deployable — Cloudflare Worker yang serve static assets/frontend
  sekaligus API routes; bukan microservices, bukan multi-platform)

PROJECT NAME: meeting-assistant

ONE-LINE PURPOSE: Asisten browser pribadi yang menangkap audio meeting
  online (mic + audio sistem), mentranskrip & menerjemahkan real-time,
  serta membantu merangkai respons untuk meeting klien asing dan latihan
  interview — tanpa instalasi software tambahan.

PRIMARY USERS: Banu sendiri (single user, personal use, tidak untuk dijual)

CORE FEATURES (3–7):
  1. Tangkap audio meeting (mic + audio sistem/tab via getDisplayMedia)
     dari aplikasi meeting apa pun, tanpa instalasi tambahan
  2. Transkripsi + terjemahan real-time (Indonesia ↔ Inggris) via Groq
     Whisper
  3. Bantu merangkai respons meeting klien — user supply poin kasar,
     AI rapikan jadi kalimat fasih ("Steer AI"-style, substansi tetap
     dari user)
  4. Upload konteks (CV, job description, product/marketing knowledge)
     untuk personalisasi jawaban per mode
  5. Mode latihan interview: praktik + feedback setelah sesi selesai
     (bukan live-read saat interview asli — lihat OUT OF SCOPE)
  6. Routing LLM multi-provider dengan fallback otomatis (OpenRouter →
     Groq → Mistral → SambaNova)
  7. Auth toggle — Basic Auth aktif hanya saat deployment publik

TECH STACK PREFERENCES:
  - Language/Runtime: JavaScript — Cloudflare Workers runtime (V8
    isolate) untuk backend; browser-native JS (ES modules) untuk
    frontend, tanpa Node.js server terpisah
  - Framework: Tidak ada framework backend (native Workers `fetch`
    handler). Frontend: vanilla JS tanpa build step (rekomendasi,
    konsisten dengan prinsip client-side-settings & zero-install) —
    Alpine.js/Preact jadi opsi kalau butuh struktur lebih; belum final
  - Database: none — semua state pengguna (CV, JD, product knowledge,
    riwayat) di localStorage/IndexedDB browser, tidak ada penyimpanan
    server-side untuk MVP
  - Hosting/Infra: Cloudflare Workers (serverless, free plan) — bukan
    container-orchestrated; satu deployable untuk static assets + API
  - Key third-party services dan webhook providers: OpenRouter, Groq,
    Mistral (La Plateforme), SambaNova Cloud — semua outbound API call
    dari Worker, bukan webhook masuk. Opsional: Cloudflare Access
    sebagai alternatif Basic Auth

API CONSUMERS:
  - Does this API have consumers outside this project? no
    (/api/chat dan /api/transcribe hanya dikonsumsi frontend proyek
    ini sendiri, single user, tidak ada API publik)

OBSERVABILITY:
  - Log destination: `wrangler tail` / Cloudflare dashboard Logs
    (real-time, gratis) — cukup untuk skala personal
  - Error tracking: Tidak ada tool terpisah untuk MVP; error di-return
    sebagai response HTTP, dicek manual lewat `wrangler tail` saat dev
  - Alerting: Tidak ada — pemakaian personal, tidak butuh on-call

BACKUP & RECOVERY:
  - Backup strategy: Tidak ada data pengguna di server (stateless,
    semua state di browser client) — yang perlu dibackup hanya source
    code (git) dan API key provider (password manager)
  - Max acceptable data loss (RPO): N/A untuk server (stateless);
    riwayat/CV yang tersimpan di IndexedDB browser risikonya ada di
    device pengguna, di luar cakupan RPO server
  - Recovery time target (RTO): Menitan — `wrangler deploy` ulang dari
    git, tidak ada state server yang perlu direstore

SCALE EXPECTATION:
  - Concurrent users / usage volume expected in the first 6 months: 1
    (pemakaian pribadi, bukan untuk dijual) → Simple Mode berlaku

HARD CONSTRAINTS:
  - 100% gratis untuk dijalankan — tidak ada paid tier di infrastruktur
    maupun model AI
  - Target deploy: Cloudflare Workers (free plan); local-only run via
    `wrangler dev` adalah fallback yang sah, bukan sekadar dev env
  - Tanpa instalasi software tambahan di sisi user untuk menangkap
    audio meeting (browser-only: getUserMedia + getDisplayMedia)
  - Semua state/settings pengguna client-side, bukan di server
  - Auth (Basic Auth, toggle via `AUTH_ENABLED`) wajib aktif untuk
    deployment publik; boleh nonaktif untuk local-only

OUT OF SCOPE:
  - Live verbatim AI-answer yang dibaca langsung saat interview kerja
    sungguhan (menyamarkan kemampuan asli kandidat ke pewawancara)
  - Fitur overlay/anti-deteksi yang menyembunyikan pemakaian AI dari
    peserta meeting lain (screen-share, recording)
  - Model/tier berbayar apa pun
  - Multi-user / akun terpisah / billing (personal use only)
  - Aplikasi desktop terinstal (.exe/.dmg) — tetap browser-based
