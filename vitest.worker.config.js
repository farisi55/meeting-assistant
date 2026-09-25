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
      // "kedua var ter-set" bisa diuji lewat SELF.fetch; skenario var hilang
      // diuji lewat worker.fetch dengan env sintetis di test/worker.test.js.
      miniflare: {
        bindings: {
          BASIC_AUTH_USER: 'test-user',
          BASIC_AUTH_PASS: 's3cr3t-pass',
        },
      },
    }),
  ],
  test: {
    name: 'worker',
    include: ['test/worker.test.js'],
  },
});
