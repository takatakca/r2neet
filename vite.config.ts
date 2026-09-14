import type { Connect } from 'vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const single = process.env.SINGLE_FILE === '1';

const cleanPageRoutes: Record<string, string> = {
  '/login': '/login.html',
  '/verify': '/verify.html',
  '/signup': '/signup.html',
  '/account': '/account.html',
  '/admin': '/admin.html',
  '/crew': '/crew.html',
};

function cleanPageUrls() {
  return {
    name: 'r2nette-clean-page-urls',

    configureServer(server: {
      middlewares: Connect.Server;
    }) {
      server.middlewares.use((request, _response, next) => {
        if (!request.url) {
          next();
          return;
        }

        const url = new URL(request.url, 'http://localhost');
        const replacement = cleanPageRoutes[url.pathname];

        if (replacement) {
          request.url = `${replacement}${url.search}`;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  root: 'web',

  plugins: single
    ? [viteSingleFile()]
    : [cleanPageUrls()],

  build: {
    outDir: single ? '../dist-single' : '../dist',
    emptyOutDir: true,
    target: 'es2020',

    rollupOptions: single
      ? undefined
      : {
          input: {
            index: 'web/index.html',
            login: 'web/login.html',
            verify: 'web/verify.html',
            signup: 'web/signup.html',
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