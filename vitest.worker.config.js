import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// API @cloudflare/vitest-pool-workers@0.22.0: cloudflareTest() adalah Vite
// plugin, bukan defineWorkersConfig()/defineWorkersProject() -- helper itu
// sudah tidak diekspor di versi ini meski masih muncul di sebagian
// dokumentasi. Diverifikasi langsung dari types package yang terpasang.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Kredensial dummy khusus test (bukan rahasia) supaya jalur auth
      // "token ter-set" bisa diuji lewat SELF.fetch; skenario var hilang
      // diuji lewat worker.fetch dengan env sintetis di test/worker.test.js.
      //
      // HERMETIK: bindings di bawah WAJIB menimpa .dev.vars lokal (yang
      // berisi kredensial & API key ASLI milik developer). Tanpa pinning ini,
      // AUTH_ENABLED=false di .dev.vars mematikan auth di test dan
      // handleChat melakukan panggilan jaringan asli dengan key asli.
      miniflare: {
        bindings: {
          AUTH_ENABLED: 'true',
          BASIC_AUTH_TOKEN: 'test-bearer-token-1234',
          // String kosong = falsy di worker.js → provider di-skip, tidak
          // pernah ada outbound call dari test suite.
          OPENROUTER_API_KEY: '',
          GROQ_API_KEY: '',
          MISTRAL_API_KEY: '',
          SAMBANOVA_API_KEY: '',
        },
      },
    }),
  ],
  test: {
    name: 'worker',
    include: ['test/worker.test.js'],
  },
});
