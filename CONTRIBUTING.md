# Contributing

Aturan wajib untuk setiap perubahan di repo ini. Aturan di bawah ini
mengikat — bukan saran — dan sudah dipilih secara sadar untuk proyek
personal-use ini (lihat `knowledge.md`, single source of truth).

## Jangan pernah log PII atau kredensial

**Aturan:** konten transkrip / percakapan / body request, dan nilai
kredensial apa pun, tidak boleh **pernah** diteruskan ke
`console.log` / `console.error` / `console.warn` — di `worker.js`
maupun di `public/*`.

Termasuk (tidak terbatas):

- `body` request `/api/chat`, field `messages`, dan hasil
  `request.json()`
- file audio & hasil transkrip `/api/transcribe`
- konteks yang diunggah (CV, job description, product knowledge)
- header `Authorization`, nilai `BASIC_AUTH_TOKEN`
- nilai `*_API_KEY` (OpenRouter, Groq, Mistral, SambaNova)

**Alasan:** `knowledge.md` §8 — log produksi dibaca lewat
`wrangler tail` / Cloudflare dashboard Logs, yang bisa diakses siapa
pun yang punya akses dashboard. Isi transkrip dan kredensial bukan
untuk konsumsi itu.

**Yang boleh:** metadata non-PII — nama provider, status code upstream,
durasi request, nama var env yang hilang (namanya saja, bukan
nilainya).

**Enforcement:** `test/frontend/logging-guardrail.test.js` memindai
`worker.js` terhadap aturan ini. Kalau test itu gagal, kamu baru saja
menambahkan log yang dilarang — hapus, jangan disable test-nya.

## Perubahan lain

- Test isolasi: setiap test membangun & membersihkan state-nya sendiri.
- Ikuti struktur di `knowledge.md` §3–§4 (naming, docstring satu baris
  pada tiap fungsi/method yang diekspor).
- Jangan pernah commit `.dev.vars`, `*.pem`, `*.key`, `*.p12`,
  `secrets/` — pre-commit hook memblokirnya, jangan di-bypass dengan
  `--no-verify`.
