# meeting-assistant

Asisten pribadi berbasis browser: merekam audio rapat (mic + system audio),
mentranskripsi/menerjemahkan secara real-time, dan membantu menyusun balasan
untuk pertemuan klien berbahasa asing serta latihan wawancara kerja.

Satu Cloudflare Worker menangani frontend statis + API (`fullstack`, tanpa
database, tanpa build step). Satu pengguna (personal use, free tier).

## Konfigurasi

### 1. API key — SATU-SATUNYA yang perlu dikonfigurasi

**Lokal** (`wrangler dev`):

```bash
cp .dev.vars.example .dev.vars   # lalu isi nilai asli
```

| Variabel di `.dev.vars` | Untuk apa |
|---|---|
| `GROQ_API_KEY` | Transkripsi audio (`POST /api/transcribe`, Whisper) |
| `OPENROUTER_API_KEY` | Chat — provider pertama di rantai fallback |
| `MISTRAL_API_KEY` | Chat — fallback kedua |
| `SAMBANOVA_API_KEY` | Chat — fallback ketiga |
| `BASIC_AUTH_TOKEN` | Login Bearer (hanya jika `AUTH_ENABLED=true`) — buat dengan `openssl rand -hex 32` |

Minimal isi `GROQ_API_KEY` + **salah satu** key chat. Tanpa key, endpoint
sengaja membalas 500 yang menyebut nama var yang hilang (fail-fast, bukan bug).

**Frontend & token:** kalau `AUTH_ENABLED=true`, semua request API membawa
header `Authorization: Bearer <token>`. Token diambil dari localStorage
browser dengan key `meeting-assistant.auth-token` — simpan lewat helper
`setStoredAuthToken(token)` dari `public/providers.js` (atau
`localStorage.setItem('meeting-assistant.auth-token', '<token>')` di
devtools) dengan nilai yang sama persis seperti `BASIC_AUTH_TOKEN`.

**Produksi:**

```bash
wrangler secret put GROQ_API_KEY        # ulangi untuk key lainnya
```

`.dev.vars` dan secret **tidak pernah** di-commit (diblokir pre-commit hook).

### 2. URL & model provider — TIDAK perlu dikonfigurasi

baseUrl dan model default tiap provider sudah hardcoded di konstanta
`PROVIDERS` (`worker.js`):

| Provider | baseUrl | defaultModel |
|---|---|---|
| openrouter | `https://openrouter.ai/api/v1` | `openrouter/free` |
| groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| sambanova | `https://api.sambanova.ai/v1` | `Meta-Llama-3.3-70B-Instruct` |

Urutan percobaan saat provider error/limit: `FALLBACK_ORDER` (openrouter →
groq → mistral → sambanova).

**Override bila perlu:**

- **Per request (chat)** — kirim field opsional `provider` dan/atau `model`
  di body `/api/chat` untuk memaksa satu provider/model, melewati fallback
  chain. Lewat helper frontend: `chat(messages, { provider: 'groq', model: '...' })`.
- **Per request (transcribe)** — field form `model` / `language`
  (default: `whisper-large-v3-turbo`, `id`).
- **Permanen** — ubah objek `PROVIDERS` / `FALLBACK_ORDER` di `worker.js`
  (tidak ada config env-nya). Cukup edit di satu tempat.

> Slug nama model tiap provider bisa berubah sewaktu-waktu — cross-check di
> dashboard masing-masing provider sebelum mengandalkannya di produksi.

### 3. Variabel non-secret (`wrangler.toml [vars]`)

| Variabel | Fungsi |
|---|---|
| `AUTH_ENABLED` | `"true"`/`"false"` — toggle auth Bearer token |
| `PUBLIC_URL` | URL publik Worker (dikirim sebagai `HTTP-Referer` ke OpenRouter) |

Binding `AUTH_KV` (namespace KV) diperlukan untuk proteksi brute-force
lockout; tanpanya auth tetap jalan tanpa lockout. Buat dengan
`wrangler kv namespace create AUTH_KV` lalu tempel id-nya di `wrangler.toml`.

## Menjalankan

```bash
npm install          # butuh flag legacy-peer-deps (sudah di .npmrc)
npm run dev          # wrangler dev → http://localhost:8787
npm run deploy       # wrangler deploy (manual, tanpa CI/CD)
```

## Test

```bash
npm test             # vitest run — suite worker (workerd) + frontend (jsdom)
```

Test **tidak membutuhkan API key asli** — jalur sukses di-mock dan jalur
tanpa key diuji sebagai 500 by design. Jangan menaruh key asli di config test.

## Dokumen lain

- `knowledge.md` — source of truth (arsitektur, kontrak API §5, aturan domain §7)
- `CONTRIBUTING.md` — aturan wajib kontribusi (logging aman-PII, test isolasi)
- `changelog.md` — tracker tugas (loop P03/P04)
- `prd.md` — kebutuhan produk
