import { defineConfig } from 'vitest/config';

// Dua project terpisah dalam satu proses Vitest — file terpisah (bukan
// inline) karena project "worker" butuh plugin Vite (cloudflareTest) yang
// tidak praktis ditulis inline dalam array projects. Nama file harus
// berpola vitest.<name>.config.* supaya dikenali Vitest sebagai project.
//   - vitest.worker.config.js   -> runtime Workers asli (workerd), untuk worker.js
//   - vitest.frontend.config.js -> jsdom biasa, untuk modul public/* (browser API)
export default defineConfig({
  test: {
    projects: ['./vitest.worker.config.js', './vitest.frontend.config.js'],
  },
});
