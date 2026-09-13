import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Two build targets:
 * - Default: hashed assets served by the application.
 * - SINGLE_FILE=1: one self-contained HTML booking preview.
 */
const single = process.env.SINGLE_FILE === '1';

export default defineConfig({
  root: 'web',

  plugins: single ? [viteSingleFile()] : [],

  build: {
    outDir: single ? '../dist-single' : '../dist',
    emptyOutDir: true,
    target: 'es2020',

    // The single-file preview only builds the booking page.
    // The normal build ships every application page.
    rollupOptions: single
      ? undefined
      : {
          input: {
            index: 'web/index.html',
            account: 'web/account.html',
            admin: 'web/admin.html',
            crew: 'web/crew.html',
          },
        },
  },

  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});