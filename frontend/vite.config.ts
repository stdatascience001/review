import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // In development the API is proxied through the Vite server, so the browser talks to a
  // single origin and the HTTP-only auth cookies work without cross-site configuration.
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:4000';
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    server: {
      port: Number(env.PORT) || 3000,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
        '/socket.io': { target: apiTarget, changeOrigin: false, ws: true }, // real-time
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router'],
            query: ['@tanstack/react-query', 'axios'],
            ui: ['lucide-react', 'sonner'],
          },
        },
      },
    },
    preview: {
      port: Number(env.PORT) || 3000,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
        '/socket.io': { target: apiTarget, changeOrigin: false, ws: true },
      },
    },
  };
});
