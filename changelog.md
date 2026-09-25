---
project: meeting-assistant
knowledge_version: 1.0.4
changelog_version: 1.0.10
created: 2026-09-23
status: in_progress
milestone: 1 of 1
project_shape: fullstack
simple_mode: true
---

## [IN PROGRESS]

#### Task #010A — Auth: Bearer Token (BASIC_AUTH_TOKEN) Replacing Basic User/Pass
- **Phase:** Phase 3 — Core Features
- **Scope:** Replace Basic user/pass auth with a single high-entropy bearer secret: client sends `Authorization: Bearer <UUID token>`, Worker verifies against `BASIC_AUTH_TOKEN` using constant-time comparison; reuse the existing KV lockout (3 gagal/IP, 15 menit) and the fail-fast config pattern; `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` removed from code, tests, and docs. Out-of-band insertion requested by developer, ordered before #011.
- **Files to create / modify:** `worker.js`, `test/worker.test.js`, `public/providers.js`, `test/frontend/providers.test.js`, `vitest.worker.config.js`, `.dev.vars.example`, `wrangler.toml`, `README.md`, `knowledge.md`
- **Acceptance criteria:**
  - [ ] Correct `Authorization: Bearer <token>` passes auth when `AUTH_ENABLED=true`; missing/wrong token → 401, and wrong attempts feed the same lockout counter (4th wrong → 429 via KV; a passing request clears it)
  - [ ] `AUTH_ENABLED=true` without `BASIC_AUTH_TOKEN` → fail-fast 500 naming `BASIC_AUTH_TOKEN`; `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` appear nowhere in code or test config (grep-clean)
  - [ ] Token comparison uses constant-time comparison (`crypto.subtle.timingSafeEqual`); @knowledge §5 (auth contract) + §8 (env vars) + §9 (secret-comparison policy) updated this task
  - [ ] Frontend stays usable with auth enabled: `providers.js` attaches a stored token from localStorage as `Authorization: Bearer` when configured
  - [ ] Unit tests written and passing (worker auth/lockout/fail-fast + providers header attach), hermetic bindings updated, test isolated
  - [ ] `.dev.vars.example`, `wrangler.toml` comments, and `README.md` show only the token scheme (no stale Basic-auth instructions)
- **Dependencies:** Task #003, Task #006, Task #009
- **Decisions made:** _(fill after execution — never leave blank)_

---

## [NEXT TASKS]

### Phase 3 — Core Features

#### Task #011 — Feature: Interview-Practice Mode
- **Phase:** Phase 3 — Core Features
- **Scope:** Implement the practice flow from @knowledge §7: AI asks one question derived from CV+JD, user answers, and feedback is shown only after the user explicitly marks the answer complete — never while answering.
- **Files to create / modify:** `public/app.js`
- **Acceptance criteria:**
  - [ ] No feedback UI is rendered, and no feedback-requesting `/api/chat` call is made, before the user marks the current answer complete
  - [ ] Feedback generation uses the CV/JD context assembled per Task #008's character limit
  - [ ] Unit test written and passing for new logic (the state-machine rule "no feedback before mark-complete" tested directly)
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #008, Task #009
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #012 — Audio → Transcript → Response Pipeline Wiring
- **Phase:** Phase 3 — Core Features
- **Scope:** Wire `audio-capture.js` → `providers.js` (`/api/transcribe`) → context-aware `/api/chat` call → UI display, implementing the client-meeting data flow from @knowledge §3.
- **Files to create / modify:** `public/app.js`
- **Acceptance criteria:**
  - [ ] Audio from the shared system-audio stream results in a transcript rendered in the UI
  - [ ] The AI-drafted response reflects the currently active mode's persona/context
  - [ ] Unit test written and passing for new logic (orchestration logic tested with capture/network mocked)
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #007, Task #008, Task #009, Task #010
- **Decisions made:** _(fill after execution — never leave blank)_

### Phase 4 — Integration

#### Task #013 — Outbound Timeouts for All Provider Calls
- **Phase:** Phase 4 — Integration
- **Scope:** Wrap every outbound `fetch()` in `worker.js` (OpenRouter, Groq chat, Mistral, SambaNova, Groq Whisper) with an `AbortController` timeout so a hung upstream provider cannot hang the whole request. Circuit breaker is intentionally skipped (`simple_mode: true`).
- **Files to create / modify:** `worker.js`
- **Acceptance criteria:**
  - [ ] Every provider `fetch()` call has an explicit timeout (e.g. 15s chat, 30s transcribe)
  - [ ] A simulated hung/never-resolving provider is treated like a failed response — the fallback chain advances rather than hanging
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #005
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #014 — Verify Fallback Handles Provider-Specific 429s
- **Phase:** Phase 4 — Integration
- **Scope:** Confirm the fallback chain correctly advances specifically on a 429 (not only generic 5xx) from each of the four providers, matching the per-provider rate limits documented in @knowledge §9.
- **Files to create / modify:** `test/worker.test.js`
- **Acceptance criteria:**
  - [ ] A mocked 429 from OpenRouter causes fallback to Groq
  - [ ] A mocked 429 from every provider in the chain returns the last provider's actual 429 status/body to the client, not a generic 500
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #005
- **Decisions made:** _(fill after execution — never leave blank)_

### Phase 5 — UI/UX

#### Task #015 — XSS-Safe Rendering for Transcript & AI Output
- **Phase:** Phase 5 — UI/UX
- **Scope:** Ensure every place that renders transcript text, AI responses, or uploaded context uses safe DOM text APIs exclusively, per @knowledge §6 — transcript content originates from a third party and must be treated as untrusted. Subresource Integrity is not applicable (no CDN-loaded scripts in this architecture).
- **Files to create / modify:** `public/app.js`, `public/audio-capture.js`
- **Acceptance criteria:**
  - [ ] A transcript chunk containing `<script>` or HTML-special characters renders as literal visible text, never as parsed markup
  - [ ] No `innerHTML` assignment anywhere in the codebase receives unescaped transcript/response/context content (grep-verifiable)
  - [ ] Unit test written and passing for new logic (render helper tested with a malicious-looking input string)
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #012
- **Decisions made:** _(fill after execution — never leave blank)_

### Phase 6 — Testing & QA

#### Task #016 — Full Suite Run & End-to-End Integration Test
- **Phase:** Phase 6 — Testing & QA
- **Scope:** Confirm both Vitest projects pass together, and add one integration-level test that exercises the real exported `fetch` handler end-to-end (auth → `/api/chat` → mocked provider) rather than only internal functions. No formal coverage-percentage target exists for this project (@knowledge §4), so this task verifies suite health, not a coverage number.
- **Files to create / modify:** `test/integration.test.js`
- **Acceptance criteria:**
  - [ ] `npm test` runs both Vitest projects and exits 0
  - [ ] The integration test drives the Worker's exported `fetch` handler directly and asserts a correct end-to-end response
  - [ ] No test leaves KV state behind that affects a later test run
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #005, Task #006, Task #013, Task #014
- **Decisions made:** _(fill after execution — never leave blank)_

### Phase 7 — Deployment (Server variant)

#### Task #017 — Production Deployment & Manual Smoke Verification
- **Phase:** Phase 7 — Deployment
- **Scope:** Deploy to Cloudflare Workers production and verify manually. This project has no staging environment (@knowledge §8 — dev/prod only), so pre-deploy verification happens via local `wrangler dev`, followed by a direct smoke check against the live production URL after deploy.
- **Files to create / modify:** `wrangler.toml` (final secrets/vars confirmed), `DEPLOY.md`
- **Acceptance criteria:**
  - [ ] `wrangler deploy` succeeds and the app is reachable at its production URL
  - [ ] All required secrets/vars from @knowledge §8 are confirmed present (`wrangler secret list` + manual check of `[vars]`)
  - [ ] A real end-to-end request (login if `AUTH_ENABLED=true`, then one `/api/chat` call) succeeds against production within the response-time budget from @knowledge §9
  - [ ] The deployed commit is git-tagged per @knowledge §7's `vX.Y.Z` format
- **Dependencies:** Task #001, Task #016
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #018 — Rollback Procedure Documented & Dry-Run Tested
- **Phase:** Phase 7 — Deployment
- **Scope:** Document the rollback procedure (redeploy the previous git tag via `wrangler deploy`) and perform one real dry-run to confirm it works within the target time.
- **Files to create / modify:** `DEPLOY.md`
- **Acceptance criteria:**
  - [ ] Rollback steps are written as a short, followable procedure
  - [ ] A dry-run rollback (deploy tag N, then redeploy tag N-1) completes in under 10 minutes
  - [ ] A post-rollback smoke check confirms the app responds correctly on the older version
- **Dependencies:** Task #017
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #019 — Basic Concurrency Smoke Test (Stage 1 only)
- **Phase:** Phase 7 — Deployment
- **Scope:** Run a Stage-1-only smoke load test (10 virtual users / 60 seconds) against the deployed Worker — Stage 2 capacity testing is skipped (`simple_mode: true`). The main goal is confirming the KV-based lockout counter has no race condition under concurrent requests from the same simulated IP.
- **Files to create / modify:** `scripts/smoke-load-test.js` (or documented one-off command, e.g. via `autocannon`)
- **Acceptance criteria:**
  - [ ] 10 VU / 60s against a non-mutating endpoint completes with zero 5xx errors
  - [ ] Concurrent failed-auth attempts from the same simulated IP cap at exactly 3 recorded failures, not more or fewer, despite concurrency
- **Dependencies:** Task #017
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #020 — Minimal API Documentation
- **Phase:** Phase 7 — Deployment
- **Scope:** Write a short OpenAPI-style spec for the two endpoints, matching the request/response shapes documented in @knowledge §5, and confirm it matches live behavior.
- **Files to create / modify:** `docs/api.yaml`
- **Acceptance criteria:**
  - [ ] `docs/api.yaml` is well-formed OpenAPI 3.x
  - [ ] A manual request against each endpoint matches its documented request/response shape
- **Dependencies:** Task #005, Task #006
- **Decisions made:** _(fill after execution — never leave blank)_

---

## [COMPLETED]
> Changelog v1.0.0 initialized from @knowledge v1.0.0. Shape: fullstack.

### Task #001 — Repo Scaffolding, Lockfile & Dual Vitest Setup ✅
- **Completed:** 2026-09-24
- **Phase:** Phase 1 — Foundation
- **Status:** OK
- **Branch:** feat/task-001-repo-scaffolding-vitest-setup
- **Files created / modified:**
  - `package.json` — devDependencies (vitest, @cloudflare/vitest-pool-workers, jsdom, wrangler), scripts (dev/deploy/test/test:watch/prepare)
  - `.gitignore` — node_modules/, .dev.vars, .env, .env.*, *.pem, *.key, *.p12, secrets/, .wrangler/
  - `.dev.vars.example` — local-secrets template, no real values
  - `.npmrc` — legacy-peer-deps=true (see Decisions made)
  - `.githooks/pre-commit` — blocks committing .dev.vars/*.pem/*.key/*.p12/secrets/ (folded in from Task #002)
  - `vitest.config.js`, `vitest.worker.config.js`, `vitest.frontend.config.js` — dual-project Vitest setup
  - `test/worker.test.js` — 2 tests
  - `test/frontend/harness.test.js` — 2 tests
  - `wrangler.toml` — compatibility_date 2026-09-22 → 2026-08-22; AUTH_KV id still placeholder
  - `knowledge.md` — §3 and §9 updated (drift resolution)
- **Acceptance criteria met:**
  - [x] `.dev.vars` and `node_modules/` ignored even when present (verified via `git check-ignore -v`)
  - [x] `npm install` succeeds, `package-lock.json` committed
  - [ ] **NOT MET** — `wrangler kv namespace create AUTH_KV` requires Banu's own Cloudflare account; not runnable from this sandboxed execution environment (no Cloudflare network access). See Notes.
  - [x] `npx vitest run` executes both projects, zero config errors
  - [x] Unit test written and passing (4/4)
  - [x] Test isolated (verified explicitly)
- **Security gate:** BASIC — all checks passed (2 gaps found and fixed: `.gitignore` missing patterns; pre-commit hook didn't exist yet)
- **Scalability gate:** BASIC — all checks passed (2 items intentionally not implemented — request correlation ID, structured logger — per knowledge.md §8's explicit minimal-observability decision, not a gap)
- **Regression:** Passed 4 tests, 0 failed (`npx vitest run`, 1.57s)
- **Decisions made:**
  - [INFRA] Folded Task #002 (pre-commit hook) into this task — Phase 1 BASIC security gate requires an active, tested hook, which didn't exist until now; implemented via `.githooks/` + `core.hooksPath` + npm `prepare` script rather than adding `husky`
  - [INFRA] `@cloudflare/vitest-pool-workers@0.22.0` does not export `./config` (`defineWorkersConfig`/`defineWorkersProject` unavailable) despite most published docs showing that API — used the verified-working `cloudflareTest` Vite-plugin API instead, confirmed directly from the installed package's type definitions
  - [INFRA] Added `.npmrc` with `legacy-peer-deps=true` — plain `npm install` reproducibly crashes with an npm arborist bug on this exact dependency set; verified `vitest` still dedupes to a single correct `4.1.11` with the flag on
  - [INFRA] Lowered `wrangler.toml` `compatibility_date` from `2026-09-22` to `2026-08-22` — locally installed workerd binary doesn't support the later date yet
  - [ARCH] Split Vitest config into 3 files rather than one inline `projects` array — `cloudflareTest` is a Vite plugin, doesn't inline cleanly as a `projects`-array object literal
- **Notes:** **Manual step required before deploying or running anything that needs lockout protection:** run `wrangler kv namespace create AUTH_KV` and paste the resulting id into `wrangler.toml`. This sandboxed environment has no network path to Cloudflare, so it could not be run here. Everything else in this task is verified working without it — the `AUTH_KV` binding is optional/fail-open by existing design.
- **Knowledge drift:** UPDATE REQUIRED: knowledge.md §3 — module structure updated (`.githooks/`, `.npmrc`, `.dev.vars.example`, split Vitest configs, `test/frontend/`); §9 — 3 new known-limitations entries added. Bumped to v1.0.1.

### Task #002 — Pre-commit Hook Blocks Secret Files — MERGED into Task #001
- **Merged:** 2026-09-24
- **Reason:** Phase 1's BASIC Security Gate requires an active, tested pre-commit hook before Task #001 itself can pass — rather than let Task #001 fail on a pure sequencing artifact, its scope was absorbed into Task #001's execution.
- **Original acceptance criteria:** both met — verified as part of Task #001 (see above)

### Task #003 — Fail-Fast Config Check for Auth ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 1 — Foundation
- **Status:** OK
- **Branch:** feat/task-003-fail-fast-auth-config
- **Files created / modified:**
  - `worker.js` — new `authConfigError(env)` fail-fast check (exported for tests), invoked first in the `fetch` handler — before auth, routing, and static serving
  - `test/worker.test.js` — 7 new tests: missing USER / missing PASS / both missing → 500 naming the var(s); fail-closed on static asset path; `AUTH_ENABLED=false` passthrough; correct vs wrong Basic credentials; `authConfigError` unit cases
  - `vitest.worker.config.js` — test-only dummy `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` miniflare bindings (non-secret fixtures) so the "both vars set" path is exercised through the real `SELF.fetch` dispatch
  - `.githooks/pre-commit` — restored to version control (had been untracked by out-of-band commit 7adb43f)
  - `.gitignore` — removed the `.githooks/` ignore line added by 7adb43f; all secret patterns (`.env`, `*.pem`, `*.key`, `*.p12`, `.dev.vars`) untouched
  - `knowledge.md` — §5 error-response contract now documents the fail-fast exception; bumped to v1.0.2
- **Acceptance criteria met:**
  - [x] `AUTH_ENABLED=true` with either credential var unset returns HTTP 500 with a message naming the missing var (covered: USER-only, PASS-only, both-missing; message names exactly the missing var(s))
  - [x] `AUTH_ENABLED=true` with both credential vars set behaves exactly as before — both pre-existing auth tests pass **unmodified**; correct creds → 200, wrong creds → 401
  - [x] Unit test written and passing for new logic (7 new tests)
  - [x] Test is isolated: sets up and tears down its own state — every test builds its own synthetic `env`; no shared KV/localStorage state; the fail-fast path returns before any KV read/write
- **Security gate:** STANDARD — all checks passed [— HIGH-RISK OVERRIDE: auth task, Phase 1 would otherwise be BASIC] [— simple_mode: 0 items skipped; simple_mode only ever skips scale-apparatus items, never security baseline]
- **Scalability gate:** BASIC — all checks passed [— simple_mode: 0 items skipped (no skippable items in BASIC tier)]
- **Regression:** Passed 11 (4 baseline + 7 new), 0 failed (`npm test` → `vitest run`, 1.64s); `node --check worker.js` OK
- **Decisions made:**
  - [ARCH] Fail-fast runs before `checkAuth` **and** before routing: with creds unset every request401s, so only a pre-auth check can surface the misconfig — and it fails closed for the static frontend too, not just `/api/*`
  - [API] The 500 body is plain text naming only the missing **var names** (never values), with no `WWW-Authenticate`; recorded in knowledge §5 as a local exception to the "upstream passthrough, no custom envelope" rule — it is a deployment-misconfiguration diagnostic, not an API error envelope
  - [TEST] Added dummy auth bindings in `vitest.worker.config.js` instead of rewriting the 2 pre-existing tests: keeps the regression baseline byte-identical and gives Task #006 a working creds-set path for `SELF.fetch` lockout tests; missing-var scenarios drive the real exported `fetch` handler with per-test synthetic `env`, because `@cloudflare/vitest-pool-workers@0.22.0` has no per-test env-override API
  - [INFRA] Re-tracked `.githooks/pre-commit` and dropped `.githooks/` from `.gitignore` — out-of-band commit 7adb43f had untracked the hook, leaving the Phase 1 pre-commit control active only on this working copy (a fresh clone + `npm prepare` would point `core.hooksPath` at a nonexistent file and silently do nothing); verified live: staged `.dev.vars` → commit rejected, exit 1
- **Notes:** No git remote exists (`git remote -v` empty), so the protocol's `git pull/push origin dev` steps could not run — work merged to local `dev` only; Banu should add a remote if off-machine backup is wanted. Pre-existing observations, deliberately untouched (not gate failures for this task's diff): (1) ESLint is named in knowledge §4 but has no dependency or config in the repo, so the Phase 1 lint step was covered by `node --check` + the full suite; (2) `POST` body parsing has no Content-Type guard and no try/catch at the parse site — no scheduled task covers it; worth a future task if this API ever gains external consumers.
- **Knowledge drift:** UPDATE REQUIRED: @knowledge §5 — documented the fail-fast 500 auth-config exception to the error-response contract (edit already applied this task); version bumped 1.0.1 → 1.0.2, `knowledge_version` synced.

### Task #004 — PII-Safe Logging Guardrail ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 1 — Foundation
- **Status:** OK
- **Branch:** feat/task-004-pii-safe-logging-guardrail
- **Files created / modified:**
  - `worker.js` — `PII-SAFE LOGGING` guard comment at the top of `checkAuth`, `handleChat`, and `handleTranscribe` (comment-only diff — zero runtime behavior change, verified line-by-line)
  - `CONTRIBUTING.md` — explicit no-PII-logging rule (transcript/body/credential values never to `console.*`), rationale from knowledge §8, the non-PII metadata that IS allowed, and a pointer to the enforcing test
  - `test/frontend/logging-guardrail.test.js` — 3 source-scan tests: no `console.*` call in `worker.js` references body/messages/transcript/credentials; guard present in all 3 handlers; CONTRIBUTING.md states the rule
  - `knowledge.md` — §3 structure tree adds `CONTRIBUTING.md`; bumped to v1.0.3
- **Acceptance criteria met:**
  - [x] No existing `console.*` call in `worker.js` includes request body, message content, or credential values — now verified mechanically by the scan test (zero `console.*` calls exist today; comment lines are stripped before scanning so the guard text, which must name the forbidden tokens to explain them, cannot false-positive)
  - [x] `CONTRIBUTING.md` states the no-PII-logging rule explicitly for future changes
  - [x] Unit test written and passing for new logic (3 tests)
  - [x] Test is isolated: sets up and tears down its own state — read-only file scans create no state; each test reads its own source
- **Security gate:** STANDARD — all checks passed [— HIGH-RISK OVERRIDE: touches credential handling (`checkAuth`)] [— simple_mode: 0 items skipped; simple_mode never skips security baseline]
- **Scalability gate:** BASIC — all checks passed [— simple_mode: 0 items skipped]
- **Regression:** Passed 14 (11 baseline + 3 new), 0 failed (`npm test` → `vitest run`, 1.38s); `node --check worker.js` OK
- **Decisions made:**
  - [TEST] Guardrail implemented as an executable source-scan test rather than prose-only, placed in the Node-side (jsdom) Vitest project — the worker project runs in workerd without filesystem access; the scan strips `//` and `*` comment lines first so guard comments (which necessarily name the forbidden tokens) never trip the detector
  - [TEST] Negative verification performed before sign-off: injected `console.log("debug", body)` into `worker.js` → guardrail test failed naming the offending line, then restored → suite green; proves the rule enforces, not decorates
  - [PATTERN] Rule bans only PII-bearing logs, not `console.*` outright — knowledge §8 forbids transcript/credential content, not non-PII diagnostics (provider name, status code, duration); a blanket ban would break future legitimate logging. Denylist: body, messages, transcript, Authorization, BASIC_AUTH_*, API_KEY, apiKey, password, decoded, encoded
- **Notes:** No git remote — `git pull/push origin dev` N/A (same as #003); merge is local to `dev`. ESLint still absent from the repo (pre-existing, recorded in Task #003 Notes).
- **Knowledge drift:** UPDATE REQUIRED: @knowledge §3 — added `CONTRIBUTING.md` to the module structure tree (edit applied this task); version bumped 1.0.2 → 1.0.3, `knowledge_version` synced.

### Task #005 — Test Coverage: Chat Provider Fallback Logic ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 3 — Core Features
- **Status:** OK
- **Branch:** feat/task-005-chat-provider-fallback-tests
- **Files created / modified:**
  - `test/worker.test.js` — 6 new tests for the `handleChat`/`callProvider` fallback chain: non-2xx → next provider in `FALLBACK_ORDER`; missing-key provider skipped without throw and without a network call; chain exhaustion returns the last provider's real status/body; forced `provider` bypasses the chain; unknown `provider` → 500 with zero outbound calls; no keys at all → 500
  - `worker.js` — **unchanged**: no bug surfaced (mutation check below confirmed the tests would catch one; `git diff worker.js` empty)
- **Acceptance criteria met:**
  - [x] Test confirms a non-2xx response from one provider causes fallback to the next provider in `FALLBACK_ORDER` (openrouter 500 → groq 200, `_provider: 'groq'`, exact call order asserted)
  - [x] Test confirms a provider with no API key env var set is skipped without throwing (only `GROQ_API_KEY` set → openrouter never called, groq answers)
  - [x] Unit test written and passing for new logic (6 tests)
  - [x] Test is isolated: sets up and tears down its own state — mock installed in `beforeEach`, `globalThis.fetch` restored in `afterEach`, `outboundCalls`/`routes` rebuilt per test, synthetic `env` per test
- **Security gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped; HIGH-RISK OVERRIDE not needed beyond Phase 3's own STANDARD tier]
- **Scalability gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Regression:** Passed 20 (14 baseline + 6 new), 0 failed (`npm test` → `vitest run`, 1.33s)
- **Decisions made:**
  - [TEST] Outbound mocking done by swapping `globalThis.fetch` per test — `cloudflare:test` in `@cloudflare/vitest-pool-workers@0.22.0` exports no `fetchMock` (verified against the package's own runtime export list), and the swap is writable in workerd; unknown hosts throw, acting as `disableNetConnect` so a missed interceptor fails the test instead of hitting the real network. **Task #013: reuse this pattern for timeout tests.**
  - [TEST] Mutation verification: inserted an early-return on non-2xx into `handleChat` → exactly the 2 fallback tests failed, everything else green → restored. Proves the suite enforces the chain rather than restating it.
  - [TEST] Auth disabled via synthetic `env` (`AUTH_ENABLED: 'false'`) in this suite to isolate the fallback chain; auth paths remain covered by the pre-existing `worker auth` + `fail-fast` suites (no overlap).
  - [API] 429-specific behaviour deliberately NOT covered here (statuses used: 500/503) — that is Task #014's exact scope; forced-provider and invalid-provider coverage added as part of "comprehensive tests" since no task owns them.
- **Notes:** No git remote — `git pull/push origin dev` N/A; merge is local to `dev`. No runtime change, so no new knowledge contract to document.
- **Knowledge drift:** none — no new library (§2), naming/test isolation per §4, no new module (§3), no API or error-contract change (§5), no infra change (§8).

### Task #006 — Test Coverage: Transcribe Proxy & Auth Lockout ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 3 — Core Features
- **Status:** OK
- **Branch:** feat/task-006-transcribe-lockout-tests
- **Files created / modified:**
  - `test/worker.test.js` — 3 new tests: missing `GROQ_API_KEY` → 500 naming the variable with zero outbound calls; 3 wrong-cred POSTs from `CF-Connecting-IP: 203.0.113.9` → 401 each and KV `authfail:203.0.113.9` = `'3'`, 4th request with **correct** creds → 429 + `Retry-After: 900` (counter unchanged); same IP: 2 failures → KV `'2'`, successful GET `/` → 200 + KV `null`, next failure → KV `'1'`
  - `worker.js` — **unchanged**: all three acceptance paths behaved per knowledge §5; no bug surfaced (mutation checks below confirmed the tests would catch one)
- **Acceptance criteria met:**
  - [x] Test confirms a missing `GROQ_API_KEY` returns a clear 500 naming the variable, not an unhandled error (key check fires before `formData()` — bodyless request proves no parse throw escapes; `outboundCalls` empty)
  - [x] Test confirms 3 failed Basic Auth attempts from the same simulated IP cause the 4th request to receive 429 even with correct credentials, and that a successful login resets the counter (`'2'` → `null` → next failure `'1'`)
  - [x] Unit test written and passing for new logic (3 tests)
  - [x] Test is isolated: sets up and tears down its own state — fetch swap in `beforeEach`/restored in `afterEach`, KV `authfail:*` key deleted in `afterEach`; the reset test starts with `toBeNull()` on the **same** key the lockout test used, so stale state from the previous test would fail it
- **Security gate:** STANDARD — HIGH-RISK OVERRIDE (auth scope): all checks passed [— Phase 3 STANDARD raised by override; simple_mode: 0 items skipped]
- **Scalability gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Regression:** Passed 23 (20 baseline + 3 new), 0 failed (`npm test` → `vitest run`, 1.39s); pre-commit hook re-verified this task (staged `.dev.vars` → exit 1)
- **Decisions made:**
  - [TEST] Lockout tests drive the **real `AUTH_KV` binding** from `cloudflare:test` (placeholder id works under miniflare) rather than a fake KV — the KV contract itself (`get`/`put` w/ `expirationTtl`/`delete`) is under test, and the scenario would silently pass against a too-faithful mock. `env` added to the existing `cloudflare:test` import.
  - [TEST] Both lockout tests deliberately share one IP + `afterEach` KV delete + starting `toBeNull()` assert — makes the isolation criterion self-proving instead of claimed.
  - [TEST] Mutation verification, one per test: `MAX_AUTH_FAILURES` 3→999 → lockout test failed; counter-reset `delete` removed → reset test failed; GROQ 500 block removed → transcribe test failed (would otherwise throw at `formData()`); each mutation reverted individually, suite green after restore.
  - [PATTERN] Synthetic `worker.fetch(request, env)` pattern from #003 reused for per-test env; `globalThis.fetch` swap from #005 reused as `disableNetConnect` — no new test infrastructure.
- **Notes:** No git remote — `git pull/push origin dev` N/A; merge is local to `dev`. ESLint still absent (pre-existing, recorded in #003). KV `expirationTtl` unit (900s) asserted via `Retry-After` header rather than TTL introspection — miniflare clock not advanced.
- **Knowledge drift:** none — lockout contract documented in §5 already (429 even with correct creds, 15-min TTL); no new library (§2), module (§3), API (§5), or infra change (§8).

### Task #007 — Frontend: Audio Capture Module ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 3 — Core Features
- **Status:** OK
- **Branch:** feat/task-007-audio-capture-module
- **Files created / modified:**
  - `public/audio-capture.js` — **created**: ES module with `AudioCaptureError` (stable codes `NO_AUDIO_TRACK`, `MEDIA_UNAVAILABLE`, `RECORDER_UNAVAILABLE`), `assertHasAudioTrack`, `startMicCapture` (getUserMedia), `startDisplayCapture` (getDisplayMedia, rejects + cleans up on zero audio tracks), `watchTrackEnded` (→ unsubscribe fn), `stopStream`, `startChunkedRecording` (MediaRecorder timeslice → `stop()` resolves non-empty chunks); no module-level state
  - `test/frontend/audio-capture.test.js` — **created**: 10 tests under the node/jsdom Vitest project — stream exposure (mic/display), zero-audio distinct error + track cleanup, missing mediaDevices catchable error, track-presence assert, `ended` event fire + unsubscribe, chunk collection (empty filtered, final chunk on stop), timeslice/stream binding, stopStream, error-class contract
- **Acceptance criteria met:**
  - [x] Mic capture and display-media share each expose a usable `MediaStream` via the module's API (stubbed `navigator.mediaDevices`, stream identity asserted)
  - [x] Zero-audio-track `getDisplayMedia` stream triggers a distinct, catchable error (`AudioCaptureError` / `NO_AUDIO_TRACK`, not a TypeError or silent failure) and stops the leftover video track (no leaked stream)
  - [x] Unit test written and passing for new logic (10 tests, mocked `MediaStream`/`MediaRecorder`/`EventTarget` objects — no capture devices required)
  - [x] Test is isolated: fresh mock streams/track objects per test; `navigator.mediaDevices` stub restored in `afterEach` (original descriptor captured, `delete` when absent); module itself holds no module-level mutable state
- **Security gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Scalability gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Regression:** Passed 33 (23 baseline + 10 new), 0 failed (`npm test` → `vitest run`, 1.74s); `node --check public/audio-capture.js` OK; pre-commit hook re-verified (staged `.dev.vars` → exit 1)
- **Decisions made:**
  - [PATTERN] Typed `AudioCaptureError` with stable machine-readable `code` instead of generic `Error`/`TypeError` — turns the "distinct, catchable" criterion into a contract the UI layer (#011) can branch on (`NO_AUDIO_TRACK` → surface §9 browser-limitation hint) rather than string-matching messages
  - [TEST] `startChunkedRecording` takes an injectable `Recorder` option (default `globalThis.MediaRecorder`) so chunk logic runs in jsdom without real capture devices; `navigator.mediaDevices` stubbed per test with descriptor restore — same isolation discipline as #005/#006
  - [ARCH] Chunks buffered in memory until `stop()` resolves — bounded by the user-controlled recording session (personal-use MVP, 1 user, §4 coverage/scale targets); streaming upload cadence is deliberately deferred to #011's wiring decision
  - [TEST] Mutation verification, one per core behavior: disabled `assertHasAudioTrack`'s throw → exactly the 2 track-presence tests failed; removed the `ended` listener registration → exactly the `watchTrackEnded` test failed; each reverted individually, 33/33 green after restore
- **Notes:** No git remote — `git pull/push origin dev` N/A; merge is local to `dev`. Top-level `public/` folder materialized for the first time — `wrangler.toml [assets] directory = "./public"` now resolves (it pointed at a non-existent folder until this task); no drift since §3:56–62 already documented it. **Observation for developer:** no task in [NEXT TASKS] lists `public/index.html`/`public/styles.css` even though §3 documents them — flag before #016 E2E.
- **Knowledge drift:** none — module path/purpose matches §3 tree exactly (incl. §3:60 `audio-capture.js`); §9 `getDisplayMedia` limitation surfaced as the `NO_AUDIO_TRACK` contract, not new knowledge; no new library (§2), API (§5), infra (§8), or delete-strategy (§7) change.

### Task #008 — Frontend: Config Module & Context Upload (5,000-char cap) ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 3 — Core Features
- **Status:** OK
- **Branch:** feat/task-008-config-context-upload
- **Files created / modified:**
  - `public/config.js` — **created**: exports `MAX_CONTEXT_CHARS = 5000` (knowledge §7: cap lives in one configurable place)
  - `public/app.js` — **created**: side-effect-free UI entry point — `CONTEXT_FIELDS` (CV / Deskripsi Pekerjaan / Pengetahuan Produk), `validateContextField`, `loadContext` (corrupted-storage tolerant), `saveContext` (all-or-nothing cap enforcement), `mountContextPanel` (textareas + per-field `role="alert"` messages + save/status), `initApp` bootstrap
  - `test/frontend/context-upload.test.js` — **created**: 10 tests — cap boundary (5000 ok / 5001 rejected), blocked-save writes nothing, save→load round-trip, empty+corrupted+partial storage tolerance, visible over-cap message + save blocked, persistence across simulated reload, field/label/error rendering, destroy(), initApp mount + missing-root error
- **Acceptance criteria met:**
  - [x] Text over `MAX_CONTEXT_CHARS` shows a visible validation message (per-field `role="alert"`, `hidden=false`, message includes the 5000 cap) and blocks submission (save click → nothing written, no "Tersimpan" status)
  - [x] Context text persists in `localStorage` across a page reload (fresh `mountContextPanel` on the same storage repopulates every textarea — simulated reload asserted)
  - [x] Unit test written and passing for new logic (10 tests)
  - [x] Test is isolated: `localStorage.clear()` in both `beforeEach` and `afterEach`; fresh `root` element per test, removed in `afterEach`
- **Security gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Scalability gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Regression:** Passed 43 (33 baseline + 10 new), 0 failed (`npm test` → `vitest run`, 1.98s); `node --check` on both new files OK; pre-commit hook re-verified (staged `.dev.vars` → exit 1)
- **Decisions made:**
  - [PATTERN] All-or-nothing save: any over-cap field blocks the entire write (no partial persistence) — makes "blocks submission" testable as `localStorage` untouched, and prevents a half-saved context from being mistaken for a complete one
  - [PATTERN] `public/app.js` kept side-effect free (no top-level DOM access): browser bootstraps via explicit `initApp()`, tests mount panels directly — importing the entry module never mutates a page (also required for #010–#013/#015 which will import from it)
  - [ARCH] "Upload UI" implemented as paste-in textareas per field, not file inputs: knowledge §7 governs "context text" and all four acceptance criteria are text-based; a FileReader import path adds async surface with zero acceptance coverage — deferred unless requested
  - [PATTERN] `localStorage` holds context text (CV/JD/product knowledge), never tokens/credentials — §9's "plain local storage" ban targets secrets; §3 explicitly prescribes localStorage for client-side state
  - [TEST] Mutation verification: bypassed `saveContext`'s cap check → exactly the 2 blocked-save tests failed; skipped restore-on-mount population → exactly the persistence test failed; each reverted individually, 43/43 green after restore
- **Notes:** No git remote — `git pull/push origin dev` N/A; merge is local to `dev`. First task modifying `public/app.js` — forward impact: #010, #011, #012, #015 also modify it (tracked, intentional). UI text is Indonesian, consistent with `worker.js` response messages. The #007 note stands: no tracker task creates `public/index.html`/`public/styles.css`.
- **Knowledge drift:** none — cap constant + client-side validation + localStorage persistence are verbatim §7 rules; module paths per §3; no new library (§2), naming per §4 (kebab-case files, camelCase functions, one-line comments on every export), no API (§5), infra (§8), or delete (§7) change.

### Task #009 — Frontend: Providers Client Helper ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 3 — Core Features
- **Status:** OK
- **Branch:** feat/task-009-providers-client-helper
- **Files created / modified:**
  - `public/providers.js` — **created**: `ProvidersError` (codes `VALIDATION`/`HTTP`/`INVALID_RESPONSE`/`ABORTED`/`NETWORK`, carries `status`/`body`/`endpoint`), `chat(messages, options)` → `{ text, provider, raw }` with `_provider` surfaced, `transcribe(file, options)` → `{ text, raw }`; injectable `fetchFn`, explicit `AbortSignal` timeouts (60s chat / 120s transcribe, configurable)
  - `test/frontend/providers.test.js` — **created**: 11 tests — success resolves text+`_provider` + request shape, option passthrough (`provider`/`model`/`temperature`/`max_tokens`), 429 all-failed caught via try/catch, 500 plain-text surfaced, 3× `INVALID_RESPONSE` (missing `_provider`, missing `choices`, broken JSON), pre-network `VALIDATION`, transcribe FormData + 400 failure + Blob validation, AbortSignal wiring + abort→`ABORTED`, network→`NETWORK`
- **Acceptance criteria met:**
  - [x] Mocked successful `/api/chat` resolves with both the reply text and `_provider` (`{ text: 'halo dari groq', provider: 'groq' }`, raw payload retained)
  - [x] Mocked all-providers-failed response (429 passthrough per §5) surfaces a **catchable** `ProvidersError` — asserted via explicit try/catch capture *and* `rejects.*`; never an unhandled rejection
  - [x] Unit test written and passing for new logic (11 tests)
  - [x] Test is isolated: every test builds its own `fetchFn` closure (captured calls local to the test); module holds zero module-level mutable state — no global `fetch` mutation, nothing to leak between tests
- **Security gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Scalability gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Regression:** Passed 54 (43 baseline + 11 new), 0 failed (`npm test` → `vitest run`, 2.08s); `node --check public/providers.js` OK; pre-commit hook re-verified (staged `.dev.vars` → exit 1)
- **Decisions made:**
  - [PATTERN] Injectable `fetchFn` (default `globalThis.fetch`) instead of the #005/#006 global-swap pattern — this is a caller-invoked helper, so constructor-style injection gives per-test isolation with zero global mutation; the swap pattern remains correct for handler-driven worker tests (documented in #005)
  - [PATTERN] Every failure (HTTP status, malformed payload, abort, network) funnels into one `ProvidersError` with stable `code` + `status`/`body`/`endpoint` — gives #012's UI a single catch branch per state instead of string-matching; messages deliberately exclude response bodies (bodies live on the error object only, never logged — no-PII-logging rule)
  - [PATTERN] Response payload validated (`choices[0].message.content` + `_provider` required; Whisper `text` required) — contract drift from §5 fails loudly as `INVALID_RESPONSE` rather than resolving `undefined` into the UI
  - [PATTERN] Endpoint paths hardcoded (`/api/chat`, `/api/transcribe`) — no caller-supplied URLs, so the helper cannot be steered elsewhere
  - [TEST] Mutation verification: disabled `throwHttpError` on `/api/chat` → exactly the 2 HTTP-failure tests failed; disabled payload validation → exactly the `INVALID_RESPONSE` test failed; each reverted, 54/54 green after restore
- **Notes:** No git remote — `git pull/push origin dev` N/A; merge is local to `dev`. "Request body size limits" assessed at source: messages are composed downstream from #008's 5,000-char-capped context fields; no second cap warranted in the transport helper. Correlation-ID item per §8's explicit "no request_id envelope" decision.
- **Knowledge drift:** none — wrapper conforms to §5 schemas verbatim (`_provider` passthrough, error status+body passthrough); §3:61 documents this module; naming/one-line-docstrings per §4; no new library (§2), infra (§8), or delete (§7) change.

### Task #010 — Feature: "Steer AI" Response Drafting Mode ✅
- **Completed:** 2026-09-25
- **Phase:** Phase 3 — Core Features
- **Status:** OK
- **Branch:** feat/task-010-steer-ai-response-drafting
- **Files created / modified:**
  - `public/app.js` — **modified**: `STEER_SYSTEM_PROMPT` (exported; explicitly forbids new claims/facts/examples/statistics/commitments per §7), `draftSteer(points, options)` → validates + assembles `[system, user]` messages → `chat()` from Task #009, `mountSteerPanel(root, {fetchFn})` (points textarea → "Susun" → output via textContent + visible "Salin" copy action + inline status/error, submit disabled while in flight), `initApp` now mounts **both** context and steer panels into wrapper roots (composite `destroy()`)
  - `vitest.worker.config.js` — **modified (hermetic fix, see Notes)**: pinned all sensitive vars via `miniflare.bindings` (`AUTH_ENABLED='true'`, dummy creds, 4 API keys = `''`)
  - `test/frontend/steer-drafting.test.js` — **created**: 8 tests — prompt-forbids-new-claims (pure, zero network), draft wiring (mocked fetchFn, asserts system+user messages), pre-network VALIDATION, submit→render→copy-visible, clipboard write exact text + "Tersalin", failed draft error surfacing, copy-failure inline message, `initApp` dual-panel mount
- **Acceptance criteria met:**
  - [x] Submitting rough points produces fluent output via `/api/chat` through a system prompt that explicitly forbids introducing new claims (prompt content asserted by regex; request body proven to carry it as `messages[0]`; no live network in tests)
  - [x] Output rendered with a visible copy action (`steer-copy` button flips `hidden=false` only after a successful draft; clipboard write asserted with exact output text)
  - [x] Unit test written and passing for new logic (8 tests; system-prompt construction tested without any network call)
  - [x] Test is isolated: fresh `root` per test, per-test `fetchFn` closures, `navigator.clipboard` stub restored via descriptor in `afterEach`
- **Security gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Scalability gate:** STANDARD — all checks passed [— simple_mode: 0 items skipped]
- **Regression:** Passed 62 (54 baseline + 8 new), 0 failed (`npm test` → `vitest run`, 2.41s) — **after repairing a broken baseline first** (see Notes): 2 pre-existing auth tests were failing due to `.dev.vars` leakage before any Task #010 code existed; fixed + re-verified both with and without the developer's `.dev.vars` present (54/54 each) before implementing. `node --check public/app.js` OK; pre-commit hook re-verified (staged `.dev.vars` → exit 1)
- **Decisions made:**
  - [PATTERN] Steer draft runs through Task #009's `chat()` (injectable `fetchFn`) — no second HTTP layer, so timeout/error/`ProvidersError` handling is inherited and tests stay offline
  - [PATTERN] Empty/whitespace points rejected as `ProvidersError{VALIDATION}` pre-network — same single catchable error type as transport failures (one UI catch branch)
  - [PATTERN] Copy action: `navigator.clipboard.writeText` on explicit click, failure → inline catchable message (text remains selectable) — no deprecated `execCommand`, all output via `textContent` per §6 (XSS-safe by construction)
  - [ARCH] `initApp` mounts panels into per-panel wrapper roots and returns a composite `destroy()` — keeps #008's `mountContextPanel` contract intact (its 10 tests untouched) while making the entry point own both panels
  - [TEST] Mutation verification: removed the forbid sentence from `STEER_SYSTEM_PROMPT` → exactly the prompt test failed; made `copyButton.hidden` never flip → exactly the 3 copy-dependent tests failed; each reverted, 62/62 green after restore
- **Notes:** No git remote — `git pull/push origin dev` N/A; merge is local to `dev`. **Baseline incident (pre-Step-3):** developer's local `.dev.vars` (created 16:57 from README instructions, real keys, `AUTH_ENABLED=false`) was being loaded into the worker test runtime → auth disabled in suite → `handleChat` made **real outbound calls with real API keys** (402 upstream passthrough; 2 baseline tests red, suite ~4s). Fixed by pinning all sensitive vars in `vitest.worker.config.js` `miniflare.bindings`; verified hermetic both with and without `.dev.vars` present. Forward impact: `public/app.js` also modified by #011, #012, #015 (tracked, intentional).
- **Knowledge drift:** UPDATE REQUIRED: @knowledge §9 — new known-limitation entry: `vitest-pool-workers` loads local `.dev.vars` into the test runtime; `vitest.worker.config.js` pins sensitive vars to keep the suite hermetic (edit applied this task); version bumped 1.0.3 → 1.0.4, `knowledge_version` synced.
