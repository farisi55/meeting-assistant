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
| `GROQ_API_KEY` | Transkripsi audio (`POST /api/transcribe`, Whisper) — **satu-satunya peran Groq**; `/api/chat` menolak `provider: 'groq'` |
| `OPENROUTER_API_KEY` | Chat — provider pertama di rantai fallback |
| `MISTRAL_API_KEY` | Chat — fallback kedua |
| `SAMBANOVA_API_KEY` | Chat — **keluar dari rantai default** (free tier minta billing/402); masih bisa dipaksa via `provider: 'sambanova'` |
| `BASIC_AUTH_TOKEN` | Login Bearer (hanya jika `AUTH_ENABLED=true`) — buat dengan `openssl rand -hex 32` |

Minimal isi `GROQ_API_KEY` + **salah satu** key chat. Tanpa key, endpoint
sengaja membalas 500 yang menyebut nama var yang hilang (fail-fast, bukan bug).

**Frontend & token:** lihat bagian **[Login & autentikasi](#login--autentikasi)**
di bawah — auth hanya menjaga route `/api/*`, dan token dimasukkan lewat
panel **Akses API** di UI.

**Produksi:**

```bash
wrangler secret put GROQ_API_KEY        # ulangi untuk key lainnya
```

`.dev.vars` dan secret **tidak pernah** di-commit (diblokir pre-commit hook).

### 2. URL & model provider — TIDAK perlu dikonfigurasi

baseUrl dan model default tiap provider chat sudah hardcoded di konstanta
`PROVIDERS` (`worker.js`):

| Provider | baseUrl | defaultModel |
|---|---|---|
| openrouter | `https://openrouter.ai/api/v1` | `openrouter/free` |
| mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| sambanova | `https://api.sambanova.ai/v1` | `Meta-Llama-3.3-70B-Instruct` |

**Groq tidak ada di `PROVIDERS` chat** — Groq khusus Whisper STT (brief
CORE FEATURES #2; amandemen 2026-09-28 atas #6 yang semula memasukkannya
ke rantai chat). Kirim `provider: 'groq'` ke `/api/chat` = 500 tanpa
panggilan keluar, sama seperti provider tak dikenal.

Urutan percobaan saat provider error/limit: `FALLBACK_ORDER` (openrouter →
mistral). SambaNova sengaja tidak ikut rantai — free tier-nya kini
menuntut metode pembayaran (402); aktifkan billing lalu kembalikan ke
`FALLBACK_ORDER` di `worker.js` bila diperlukan. Rantai kini hanya dua
provider: saat OpenRouter limit/timeout dan Mistral sedang 429, memang
tidak ada cadangan lagi.

**Override bila perlu:**

- **Per request (chat)** — kirim field opsional `provider` dan/atau `model`
  di body `/api/chat` untuk memaksa satu provider/model, melewati fallback
  chain. Lewat helper frontend: `chat(messages, { provider: 'mistral', model: '...' })`.
  (`groq` tidak valid untuk chat — lihat catatan di atas.)
- **Per request (transcribe)** — field form `model` / `language`
  (default: `whisper-large-v3-turbo`, `id`).
- **Permanen** — ubah objek `PROVIDERS` / `FALLBACK_ORDER` di `worker.js`
  (tidak ada config env-nya). Cukup edit di satu tempat.

> Slug nama model tiap provider bisa berubah sewaktu-waktu — cross-check di
> dashboard masing-masing provider sebelum mengandalkannya di produksi.

### 3. Variabel non-secret (`wrangler.toml [vars]`)

| Variabel | Fungsi |
|---|---|
| `AUTH_ENABLED` | `"true"`/`"false"` — toggle auth Bearer token (berlaku untuk `/api/*`) |
| `PUBLIC_URL` | URL publik Worker (dikirim sebagai `HTTP-Referer` ke OpenRouter) |

Binding `AUTH_KV` (namespace KV) diperlukan untuk proteksi brute-force
lockout; tanpanya auth tetap jalan tanpa lockout. Buat dengan
`wrangler kv namespace create AUTH_KV` lalu tempel id-nya di `wrangler.toml`.

## Login & autentikasi

**Tidak ada username dan tidak ada password.** Satu-satunya kredensial
adalah satu token rahasia (`BASIC_AUTH_TOKEN`) yang dikirim sebagai header
`Authorization: Bearer <token>`. Tidak ada form login, tidak ada akun, dan
browser tidak menampilkan prompt apa pun — prompt native hanya ada di
skema lama Basic Auth, yang sudah tidak dipakai.

### Langkah

**1. Lokal — auth mati (default, tanpa login apa pun).**
`.dev.vars` bawaan berisi `AUTH_ENABLED=false`: halaman dan API langsung
terbuka. Ini yang disarankan untuk `wrangler dev` sehari-hari.

**2. Nyalakan auth — buat token dan simpan di server.**

```bash
openssl rand -hex 32      # hasilnya 64 karakter acak
```

| Lingkungan | Cara menyimpan |
|---|---|
| Lokal | tulis `BASIC_AUTH_TOKEN=<hasil>` di `.dev.vars`, lalu set `AUTH_ENABLED=true` |
| Produksi | `wrangler secret put BASIC_AUTH_TOKEN` (isi dengan hasil command di atas), pastikan `AUTH_ENABLED = "true"` di `wrangler.toml [vars]` |

**3. Masukkan token ke browser.** Buka halaman → panel **Akses API** →
tempel token → **Simpan**. Token disimpan di localStorage browser (key
`meeting-assistant.auth-token`) dan otomatis ditempelkan ke setiap request
`/api/*`. Nilainya harus **sama persis** dengan `BASIC_AUTH_TOKEN` di server.

**4. Selesai.** Tidak ada login ulang. Token bertahan sampai kamu menghapusnya
lewat tombol **Hapus** (atau menghapus key-nya dari DevTools), atau sampai
nilainya diganti di server — token lama otomatis tidak berlaku lagi.

### Apa yang dijaga

| Path | Saat `AUTH_ENABLED=true` |
|---|---|
| `/api/chat`, `/api/transcribe` | **Butuh token** — tanpa token / salah token → `401` |
| Shell frontend (file di `public/`, mis. `app.js`) | Terbuka tanpa token |

Alasannya: browser **tidak pernah** mengirim header `Authorization` saat
memuat halaman (Bearer tidak punya prompt login seperti Basic), jadi
mengunci frontend hanya menghasilkan `401` tanpa jalan masuk. Tidak ada
rahasia di frontend — key provider tidak pernah sampai ke browser.

### Kalau ada masalah

| Gejala | Arti | Solusi |
|---|---|---|
| `401 Unauthorized` di `/api/*` | token belum disimpan di panel, atau nilainya beda dengan server | Simpan token yang benar di panel **Akses API** |
| `500 Konfigurasi auth tidak lengkap: BASIC_AUTH_TOKEN` | `AUTH_ENABLED=true` tapi token belum di-set di server (fail-fast, bukan bug) | isi `BASIC_AUTH_TOKEN` di `.dev.vars` / `wrangler secret put` |
| `429 Terlalu banyak percobaan gagal` | 3 kali token salah berturut-turut dari IP yang sama | tunggu 15 menit (reset otomatis), atau kirim token yang benar |
| Lupa token nilainya | — | lokal: lihat `.dev.vars`; produksi: buat baru dengan `wrangler secret put BASIC_AUTH_TOKEN` (menimpa yang lama), lalu Simpan nilai baru di panel |
| Halaman tidak termuat (404) | `public/index.html` belum dibuat — itu celah lama di luar auth (lihat `changelog.md`, Task #016) | ikuti Task #016 di tracker |

### Uji manual (curl)

```bash
curl -X POST https://<host>/api/chat \
  -H "Authorization: Bearer <BASIC_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"halo"}]}'
```

Tanpa header itu → `401`. Token salah → `401`, dan tiga kali salah → `429`.

### Periksa dari browser

DevTools → **Application** → **Local Storage** → origin kamu →
`meeting-assistant.auth-token`. Menghapus key-nya = "logout" (request API
kembali `401` sampai token disimpan lagi).

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
