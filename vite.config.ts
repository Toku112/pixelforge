import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME } from './src/app/brand.ts';

/** Injects the single-source product name into index.html. */
function brandHtml(): Plugin {
  return {
    name: 'pixelforge-brand-html',
    transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', APP_NAME),
  };
}

export default defineConfig({
  plugins: [react(), brandHtml()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
