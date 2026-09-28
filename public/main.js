// public/main.js — bootstrap untuk index.html: memanggil initApp() sekali saat
// halaman dimuat. Terpisah dari app.js supaya app.js tetap bebas side-effect
// (test meng-import app.js dan mount panel sendiri-sendiri), dan berupa file
// eksternal karena CSP worker hanya mengizinkan script-src 'self' — inline
// module tidak akan dieksekusi.
import { initApp } from './app.js';

initApp();
