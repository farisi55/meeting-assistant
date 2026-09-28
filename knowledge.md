---
project: meeting-assistant
version: 1.0.8
source: prd
last_updated: 2026-09-28
project_shape: fullstack
simple_mode: true
external_assets: false
---

# simple_mode: true — 6-month usage target is 1 user (personal use only), PRD §6.4 compliance stated as "none"
# external_assets: false — PRD §4.6 references no client-supplied photos/logos; typography is browser-default system-ui, not a licensed/custom font

## 1. Project Identity
- Project: meeting-assistant — browser-based personal assistant that captures
  meeting audio (mic + system audio), transcribes/translates in real time,
  and helps draft responses for foreign-language client meetings and
  job-interview practice
- Primary user: Banu (single user, personal use, not for resale)
- Project Shape: fullstack — one Cloudflare Worker deployable serves both
  static frontend and API routes. Per Phase Applicability Matrix (PRD §9):
  Phase 2 (Domain & Data) does not apply — no database. All other phases apply.
- External API consumers: none

## 2. Tech Stack
- Language: JavaScript (ES2022+)
- Runtime: Cloudflare Workers (V8 isolate) — backend; browser-native ES
  modules — frontend, no build step
- Frameworks: none — backend uses the native Workers `fetch` handler;
  frontend is vanilla JS
- Database: none for application data. Workers KV (`AUTH_KV`) is used
  narrowly for the auth lockout counter only — not application data
- Infrastructure: Cloudflare Workers, serverless, free plan
- Container orchestration: none
- Key third-party services: OpenRouter, Groq, Mistral (La Plateforme),
  SambaNova Cloud — all outbound calls
- Webhook providers: none — no inbound callbacks

## 3. Architecture
- Folder/module structure:
  ```
  project-root/
   ├── worker.js                  # Backend: auth, routing, provider fallback
   ├── wrangler.toml               # Config Cloudflare Workers + vars + KV binding
   ├── package.json
   ├── CONTRIBUTING.md             # Aturan wajib kontribusi: no-PII logging (diuji test guardrail), pre-commit, test isolasi
  ├── .npmrc                       # legacy-peer-deps=true (lihat §9 known limitations)
  ├── .dev.vars                     # Secret lokal (gitignored)
  ├── .dev.vars.example              # Template tanpa nilai asli, dicommit
  ├── .gitignore
  ├── .githooks/
  │   └── pre-commit                 # Blokir commit .dev.vars/*.pem/*.key/*.p12/secrets/
  ├── vitest.config.js                # Root: daftar project (lihat di bawah)
  ├── vitest.worker.config.js          # Project "worker": plugin cloudflareTest
  ├── vitest.frontend.config.js         # Project "frontend": environment jsdom
  ├── public/                # Frontend statis, di-serve oleh Worker
  │   ├── index.html
  │   ├── app.js               # Entry point UI
  │   ├── config.js             # Konstanta konfigurasi (MAX_CONTEXT_CHARS, dll)
  │   ├── audio-capture.js      # getUserMedia + getDisplayMedia + chunking
  │   ├── providers.js           # Helper client utk /api/chat, /api/transcribe
  │   └── styles.css
  └── test/
      ├── worker.test.js          # Project "worker" (vitest-pool-workers/workerd)
      └── frontend/                # Project "frontend" (jsdom)
          └── *.test.js
  ```
  Vitest project terbagi dua file terpisah (bukan inline dalam satu array)
  karena `cloudflareTest` (dari `@cloudflare/vitest-pool-workers@0.22.0`) adalah
  plugin Vite, bukan objek config biasa — tidak praktis ditulis inline.
- Layer responsibilities: `worker.js` owns auth, routing, and provider
  fallback only — it never assembles prompts. The frontend owns all
  state, UI, and system-prompt assembly (persona/CV/JD/product knowledge)
  before calling `/api/chat`
- Design patterns: Provider fallback chain (Chain-of-Responsibility-style)
  for LLM routing across `PROVIDERS`/`FALLBACK_ORDER` in `worker.js`
- State management: client-side only (localStorage/IndexedDB); no
  server-side session — Bearer-token auth is re-verified per request, and
  the only server-side state is the KV lockout counter
- Data flow: Browser (capture audio) → chunk → `POST /api/transcribe`
  (Worker → Groq) → transcript → client assembles prompt (system:
  persona/CV/JD, user: transcript) → `POST /api/chat` (Worker → provider
  fallback chain) → response rendered in UI
- Key architectural decisions:
  - Cloudflare Workers over a traditional VPS/Node server — meets the
    100%-free hard constraint without losing a local-run option
    (`wrangler dev` reads `.dev.vars` exactly like `.env`)
  - Provider fallback chain (4 free LLM providers) over topping up
    OpenRouter credit — clears the 50-req/day free-tier cap at zero cost
  - Non-streaming chat responses over SSE streaming — lets each
    provider's status be checked before falling back to the next one;
    trade-off is no live token-by-token display
  - Client-side state (localStorage/IndexedDB) over a server-side
    database — matches the personal-use simplicity constraint and avoids
    server backup/RPO requirements entirely
  - Auth toggle via env var over Cloudflare Access as the default — a
    single high-entropy Bearer secret (`BASIC_AUTH_TOKEN`, Task #010A)
    instead of the PRD's username+password pair; Access remains available
    as an optional extra layer

## 4. Code Standards
- Naming: files kebab-case; functions camelCase; classes/types PascalCase
- Function structure: async/await for all I/O — no sync I/O in request
  handlers; try/catch at the handler boundary; upstream HTTP status is
  passed through as-is rather than remapped
- Formatter: Prettier
- Linter: ESLint, plain-JS config (not @typescript-eslint)
- Testing framework: Vitest + `@cloudflare/vitest-pool-workers`
- Coverage target: none formally set (personal-use MVP scale)
- Docstring/comment requirement: one-line purpose comment on every
  exported function, class, and method

## 5. API & Data Contracts
- Base URL: `/api/` — no versioning (single internal consumer)
- API versioning / backward-compatibility policy: none required — no
  external consumers
- Rate limiting store: none — single instance/user; limits are enforced
  by upstream providers, not this Worker
- Authentication: HTTP Bearer token, toggled by `AUTH_ENABLED`. The client
  sends `Authorization: Bearer <BASIC_AUTH_TOKEN>`; the Worker compares it
  against the `BASIC_AUTH_TOKEN` env var with constant-time comparison
  (`crypto.subtle.timingSafeEqual`). Lockout: max 3 failed attempts per IP
  (`CF-Connecting-IP`), tracked in `AUTH_KV` with `expirationTtl` 900s
  (15 min); fails open (no lockout) if `AUTH_KV` is not bound. A request
  with no `Authorization` header is not counted as a failed attempt; a
  successful auth clears the counter. The browser stores its copy of the
  token in `localStorage` under `meeting-assistant.auth-token` (read by
  `public/providers.js`, helper `setStoredAuthToken`; entered by the user
  in the "Akses API" panel from `public/app.js`) — a deliberate
  single-user, personal-device choice: the token belongs to the same
  person who owns the browser profile.
- Auth scope: enforced **only on `/api/*` routes**. The static frontend
  shell is served unauthenticated even when `AUTH_ENABLED=true`, because a
  browser never attaches an `Authorization` header to a document navigation
  (Bearer has no native login prompt as Basic did) — guarding the shell
  would 401 every page load with no way in. No secrets exist in the
  frontend; the API stays guarded. The fail-fast config check (above) still
  applies to **every** path so a broken deployment fails loudly everywhere.
- Webhook inbound verification: none — no inbound webhooks
- Request / response schemas:
  - `POST /api/chat` — request: `{ messages, provider?, model?,
    temperature?, max_tokens? }`. `provider` (optional) forces one of
    `openrouter | groq | mistral | sambanova`, skipping the fallback
    chain. Response: passthrough from the upstream provider (OpenAI-
    compatible `{choices, usage, ...}`) plus a `_provider` field naming
    which provider answered.
  - `POST /api/transcribe` — request: multipart form-data `{ file,
    model?, language? }`. Response: passthrough from Groq Whisper.
- Error response format: HTTP status + upstream response body passed
  through unmodified — no `request_id` field or custom error envelope;
  this project explicitly decided against a standardized wrapper.
  Local exception (fail-fast config check): when `AUTH_ENABLED=true` but
  `BASIC_AUTH_TOKEN` is unset, the Worker returns a plain-text 500 naming
  the missing var — value never included, no `WWW-Authenticate` header —
  before auth, routing, or static serving. This is a
  deployment-misconfiguration diagnostic, not an error envelope
  Local exception (outbound timeouts): when every keyed provider exceeds
  its timeout, `POST /api/chat` returns a plain-text 504, and
  `POST /api/transcribe` returns a plain-text 504 when Groq Whisper
  exceeds its timeout — no upstream body exists to pass through.
  Timeouts are env-configurable with defaults `CHAT_TIMEOUT_MS=15000`
  and `TRANSCRIBE_TIMEOUT_MS=30000`; a hung provider counts as failed so
  the chat fallback chain advances instead of hanging
- Pagination: none

## 6. UI / UX Constraints
- Component library / design system: none — vanilla JS, no framework

### Design Tokens
- **Color palette:** not yet defined (TBD) — dark-mode direction assumed,
  no hex codes set
- **Typography:** system-ui font stack (browser default) — no custom or
  licensed font
- **Brand voice / tone:** n/a — personal tool, no external audience
- **Visual direction:** minimal, functional, dark mode preferred —
  assumed default, not finalized

- Output encoding rules (XSS prevention): all transcribed or user-supplied
  text (chat messages, uploaded CV/JD/product-knowledge, live transcript)
  must be rendered as text content (e.g. `textContent`), never injected
  via `innerHTML` unescaped — transcript content originates from a third
  party in the conversation and must be treated as untrusted

## 7. Business Logic & Domain Rules

### Domain Rules & Behavior
- Interview-practice mode must never surface a live, verbatim AI answer
  for the user to read during an actual interview — the AI acts as
  interviewer/coach only, and feedback is shown only after the user marks
  their answer complete (not while answering)
- "Steer AI" response-drafting mode may only rephrase/polish the
  substance the user already supplied — its system prompt must not let
  the model add claims or facts the user didn't provide
- Uploaded context (CV, job description, product knowledge) is capped at
  5,000 characters per field; the limit is read from `config.js`
  (`MAX_CONTEXT_CHARS`) so it's configurable in one place
- Input validation: context text over the 5,000-character cap must be
  rejected or truncated client-side with a visible validation message
- Interview-practice flow order: AI asks one question → user answers →
  user explicitly marks the answer complete → feedback is shown (never
  before that marker)
- Application versioning: manual semver (`vX.Y.Z`), tagged on significant
  releases — not strictly enforced

## 8. Environment & Configuration
- Required env vars: `AUTH_ENABLED`, `BASIC_AUTH_TOKEN`,
  `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`,
  `SAMBANOVA_API_KEY`, `PUBLIC_URL`
- Required bindings (non-secret): KV namespace `AUTH_KV` (auth
  lockout counter) — create via `wrangler kv namespace create AUTH_KV`;
  optional but recommended whenever `AUTH_ENABLED=true`
- Feature flags: none
- Observability: logs via `wrangler tail` / Cloudflare dashboard Logs, no
  structured JSON format required; no error tracking/crash reporting
  tool; no metrics; no alerting. Transcript/conversation content must
  never be logged in production — Cloudflare dashboard logs are readable
  by anyone with dashboard access.
- Health check endpoint: none — explicitly decided unnecessary
- Container secret injection: n/a — not containerized
- Build / deployment: `wrangler deploy`, manual trigger only — no CI/CD
  pipeline
- Multi-environment strategy: dev (`wrangler dev` + `.dev.vars`) / prod
  (`wrangler deploy` + `wrangler secret`) — no separate staging
  environment
- Rollback strategy: redeploy the previous git tag/commit via `wrangler
  deploy`
- Canary / staged-rollout strategy: not required — 6-month usage target
  (1 user) is far below the >1,000 threshold that would call for one
- Code graph tool: none (default for a simple_mode project this size)

## 9. Constraints & Anti-patterns
- No raw SQL (n/a — no database)
- No `any` type (n/a — plain JavaScript for MVP; applies if the project
  migrates to TypeScript)
- No sync I/O in request handlers — every provider call is async/await
  via `fetch()`
- No logging full transcript/conversation content in production
- No hard delete (n/a — no entities are stored)
- No redirect to a user-supplied URL without allowlist validation
- No unverified inbound webhook payloads (n/a — no inbound webhooks)
- No provider API keys written directly into code or
  `wrangler.toml [vars]` — only via `wrangler secret put` or `.dev.vars`
  (gitignored)
- No lockout state without an auto-reset — must use KV `expirationTtl`
  so a user can never be locked out permanently
- No uploaded context field over 5,000 characters without client-side
  validation
- Secret-comparison policy: the `BASIC_AUTH_TOKEN` secret is compared with
  constant-time `crypto.subtle.timingSafeEqual` (Task #010A replaced the
  earlier plaintext `===` Basic Auth comparison when auth moved to a single
  Bearer secret) — comparison timing must never vary with token content
- API stability policy: no external consumers currently, so no versioning
  or backward-compatibility guarantee is required; add one before
  exposing this API outside this project
- CI/CD secret policy: no CI/CD pipeline exists — deploys are manual
  `wrangler deploy` only
- CORS: not applicable for MVP — frontend and API share one origin
- Security hard rules: no secrets in source code, only `.dev.vars`
  (gitignored) or `wrangler secret`
- Local secrets file handling: `.dev.vars` is developer-owned, gitignored,
  and holds real API keys — tooling must never overwrite, truncate, or
  delete it (incident 2026-09-25: a pre-commit-hook verification step ran
  `printf 'X=1' > .dev.vars && rm -f .dev.vars`, destroying the file and
  its real keys; it had to be recreated from `.dev.vars.example` and the
  keys pasted again). Verify the hook's secret-blocking with a throwaway
  `verify-hook.pem` instead — the hook blocks `*.pem`/`*.key`/`*.p12`/
  `secrets/` too, so `.dev.vars` never needs to be touched
- Known technical limitations:
  - `npm install` on this dependency set (as of 2026-09-24, npm 10.9.7 +
    `@cloudflare/vitest-pool-workers@0.22.0` + `vitest@4.1.11`) crashes with
    an npm arborist bug ("Cannot read properties of null (reading
    'edgesOut')") during plain peer-dependency resolution; `.npmrc` sets
    `legacy-peer-deps=true` as a workaround — verified `vitest` still
    dedupes to a single correct version with the flag on
  - The locally installed `miniflare`/`wrangler` toolchain bundles a fixed
    workerd binary that only supports compatibility dates up to a certain
    point (was "2026-08-22" as of this session) — a `wrangler.toml`
    `compatibility_date` newer than that makes the local test runtime fail
    to start; re-check the supported ceiling after any
    `wrangler`/`@cloudflare/vitest-pool-workers` upgrade
  - `@cloudflare/vitest-pool-workers@0.22.0` does not export a `./config`
    subpath (`defineWorkersConfig`/`defineWorkersProject` are unavailable)
    even though this is what most current published documentation shows;
    the verified-working API on this version is the `cloudflareTest` Vite
    plugin from the package's root export, used inside a plain
    `defineConfig`/`defineProject` from `vitest/config`
  - OpenRouter `:free` models: 20 req/min; 50 req/day if no credit ever
    purchased, 1,000 req/day after purchasing ≥10 credits once
  - Groq: chat 20 req/min & 2,000 req/day; Whisper 20 req/min, 2,000
    req/day, ~8 hours of audio/day
  - Mistral La Plateforme free tier: ~1 req/sec (verify current limit on
    their dashboard)
  - SambaNova Cloud free tier: exact request limits unverified — check
    their dashboard
  - `getDisplayMedia` system-audio capture only works fully in
    Chromium-based browsers (Chrome/Edge) on Windows/Linux/ChromeOS;
    Firefox and Safari do not forward audio this way; macOS only
    forwards tab audio, not full system audio
  - `@cloudflare/vitest-pool-workers` loads a developer's local `.dev.vars`
    (real API keys, auth toggles) into the worker test runtime: a local
    `AUTH_ENABLED=false` silently disables auth in the suite and lets
    `handleChat` make real outbound calls with real keys (observed 2026-09-25:
    2 baseline tests failed with upstream-passthrough statuses).
    `vitest.worker.config.js` therefore pins every sensitive var via
    `miniflare.bindings` (auth on, dummy credentials, empty-string API keys)
    so tests are hermetic regardless of local dev config — keep those pins
    when editing that config
- Compliance / pentest requirements: none stated

### Sensitive / High-Blast-Radius Code
(none yet — populate as discovered during implementation)
