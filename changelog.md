---
project: meeting-assistant
knowledge_version: 1.0.1
changelog_version: 1.0.1
created: 2026-09-23
status: in_progress
milestone: 1 of 1
project_shape: fullstack
simple_mode: true
---

## [IN PROGRESS]

#### Task #003 — Fail-Fast Config Check for Auth
- **Phase:** Phase 1 — Foundation
- **Scope:** When `AUTH_ENABLED=true` but `BASIC_AUTH_USER` or `BASIC_AUTH_PASS` is missing, return a clear diagnostic 500 instead of the current behavior (every request silently fails auth with a generic 401, which is safe but confusing to debug).
- **Files to create / modify:** `worker.js`
- **Acceptance criteria:**
  - [ ] `AUTH_ENABLED=true` with either credential var unset returns HTTP 500 with a message naming the missing var
  - [ ] `AUTH_ENABLED=true` with both credential vars set behaves exactly as before (no regression)
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #001
- **Decisions made:** _(fill after execution — never leave blank)_

---

## [NEXT TASKS]

### Phase 1 — Foundation

#### Task #004 — PII-Safe Logging Guardrail
- **Phase:** Phase 1 — Foundation
- **Scope:** Document and enforce (via code comment + a short CONTRIBUTING note) that transcript/conversation content and credential values must never be passed to `console.log`/`console.error` in `worker.js`, per @knowledge §8.
- **Files to create / modify:** `worker.js` (guard comments at the top of `handleChat`/`handleTranscribe`/`checkAuth`), `CONTRIBUTING.md`
- **Acceptance criteria:**
  - [ ] No existing `console.*` call in `worker.js` includes request body, message content, or credential values (verified by inspection — currently zero such calls exist)
  - [ ] `CONTRIBUTING.md` states the no-PII-logging rule explicitly for future changes
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #001
- **Decisions made:** _(fill after execution — never leave blank)_

### Phase 3 — Core Features

#### Task #005 — Test Coverage: Chat Provider Fallback Logic
- **Phase:** Phase 3 — Core Features
- **Scope:** Add test coverage for the existing `handleChat`/`callProvider` fallback chain in `worker.js` (implementation already exists from a prior session; this task's remaining work is comprehensive tests and closing any gap they surface).
- **Files to create / modify:** `worker.js` (fix any bug the tests find), `test/worker.test.js`
- **Acceptance criteria:**
  - [ ] Test confirms a non-2xx response from one provider causes fallback to the next provider in `FALLBACK_ORDER`
  - [ ] Test confirms a provider with no API key env var set is skipped without throwing
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #001
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #006 — Test Coverage: Transcribe Proxy & Auth Lockout
- **Phase:** Phase 3 — Core Features
- **Scope:** Add test coverage for the existing `/api/transcribe` proxy and the `checkAuth` lockout mechanism (both already implemented).
- **Files to create / modify:** `worker.js`, `test/worker.test.js`
- **Acceptance criteria:**
  - [ ] Test confirms a missing `GROQ_API_KEY` returns a clear 500, not an unhandled error
  - [ ] Test confirms 3 failed Basic Auth attempts from the same simulated IP cause the 4th request to receive 429, and that a successful login resets the counter
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state (KV state reset between tests)
- **Dependencies:** Task #001
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #007 — Frontend: Audio Capture Module
- **Phase:** Phase 3 — Core Features
- **Scope:** Implement `public/audio-capture.js` — mic (`getUserMedia`) and system-audio (`getDisplayMedia`) capture, chunking, and explicit handling for a missing audio track or an `ended` track event, per @knowledge §9's documented browser limitations.
- **Files to create / modify:** `public/audio-capture.js`
- **Acceptance criteria:**
  - [ ] Starting mic capture and starting a display-media share each expose a usable `MediaStream` via the module's API
  - [ ] A `getDisplayMedia` stream with zero audio tracks triggers a distinct, catchable error rather than failing silently
  - [ ] Unit test written and passing for new logic (pure logic — track-presence check, `ended` handling — tested with mocked `MediaStream`/track objects, under the node/jsdom Vitest project)
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #001
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #008 — Frontend: Config Module & Context Upload (5,000-char cap)
- **Phase:** Phase 3 — Core Features
- **Scope:** Implement `public/config.js` (exports `MAX_CONTEXT_CHARS = 5000`) and the CV/job-description/product-knowledge upload UI, persisting to `localStorage` and enforcing the character cap client-side per @knowledge §7.
- **Files to create / modify:** `public/config.js`, `public/app.js`
- **Acceptance criteria:**
  - [ ] Entering context text over `MAX_CONTEXT_CHARS` shows a visible validation message and blocks submission
  - [ ] Context text persists in `localStorage` across a page reload
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state (localStorage cleared between tests)
- **Dependencies:** Task #001
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #009 — Frontend: Providers Client Helper
- **Phase:** Phase 3 — Core Features
- **Scope:** Implement `public/providers.js` — wraps `fetch` calls to `/api/chat` and `/api/transcribe`, surfaces the `_provider` field and error states to callers.
- **Files to create / modify:** `public/providers.js`
- **Acceptance criteria:**
  - [ ] A mocked successful `/api/chat` response resolves with both the reply text and `_provider`
  - [ ] A mocked all-providers-failed response surfaces a catchable error rather than an unhandled rejection
  - [ ] Unit test written and passing for new logic
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #001
- **Decisions made:** _(fill after execution — never leave blank)_

#### Task #010 — Feature: "Steer AI" Response Drafting Mode
- **Phase:** Phase 3 — Core Features
- **Scope:** Implement the response-drafting mode from @knowledge §7 — user supplies rough points, the system prompt instructs the model to rephrase only (never add new claims), result shown as copyable text.
- **Files to create / modify:** `public/app.js`
- **Acceptance criteria:**
  - [ ] Submitting rough user-supplied points produces fluent output via `/api/chat` using a system prompt that explicitly forbids introducing new claims
  - [ ] Output is rendered with a visible copy action
  - [ ] Unit test written and passing for new logic (system-prompt construction tested without a live network call)
  - [ ] Test is isolated: sets up and tears down its own state
- **Dependencies:** Task #008, Task #009
- **Decisions made:** _(fill after execution — never leave blank)_

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
