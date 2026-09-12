import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Two build targets:
 *  - default: hashed assets served by the app at /book
 *  - SINGLE_FILE=1: one genuinely self-contained HTML with everything inlined,
 *    for the portable preview. The previous "standalone" file imported modules
 *    that never travelled with it; this one actually contains them.
 */
const single = process.env.SINGLE_FILE === '1';

export default defineConfig({
  root: 'web',
  plugins: single ? [viteSingleFile()] : [],
  build: {
    outDir: single ? '../dist-single' : '../dist',
    emptyOutDir: true,
    target: 'es2020',
    // The single-file preview can only inline one entry, so it builds the
    // booking page alone; the normal build ships every page.
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
      '/api': 'http://localhost:3000',
    },
  },
});
