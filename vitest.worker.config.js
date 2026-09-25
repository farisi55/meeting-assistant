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
    }),
  ],
  test: {
    name: 'worker',
    include: ['test/worker.test.js'],
  },
});
