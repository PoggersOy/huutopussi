import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt': never silently reload mid-game; the app shows an update toast.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'Huutopussi',
        short_name: 'Huutopussi',
        description: 'Suomalainen tikkipeli — online multiplayer Huutopussi.',
        lang: 'fi',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        theme_color: '#0b3d2e',
        background_color: '#07271c',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The precached SPA shell doubles as the offline fallback page: any
        // navigation while offline serves index.html, which renders the
        // "disconnected" state until the socket reconnects.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/ws/],
      },
    }),
  ],
  server: {
    // Dev: the game server (packages/server) listens on :8080; same-origin /ws
    // in production (the server serves this package's dist/).
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
