// Builds the review widget in two steps:
//   1. dist/widget-app/  React panel (ES modules, content-hashed, lazy-loaded by the loader)
//   2. dist/widget.js    tiny classic-script loader (IIFE) that customers embed;
//                        it gets the hashed panel entry file name baked in.
// `--watch` rebuilds both whenever the sources change (used by `pnpm dev`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const define = { 'process.env.NODE_ENV': JSON.stringify('production') };

const appConfig = {
  root,
  configFile: false,
  base: './', // chunks resolve relative to the module URL, never to the host page
  plugins: [react()],
  define,
  logLevel: 'warn',
  build: {
    outDir: path.join(dist, 'widget-app'),
    emptyOutDir: true,
    target: 'es2020',
    manifest: true,
    modulePreload: false, // don't inject <link rel=modulepreload> into the host page
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: path.join(root, 'src/app/index.tsx'),
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: 'app-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
    watch: watch ? {} : null,
  },
};

const appEntry = () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'widget-app/.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find((c) => c.isEntry);
  if (!entry) throw new Error('widget app entry missing from manifest');
  return entry.file;
};

const buildLoader = () =>
  build({
    root,
    configFile: false,
    logLevel: 'warn',
    define: { ...define, __APP_ENTRY__: JSON.stringify(`widget-app/${appEntry()}`), __WIDGET_VERSION__: JSON.stringify('0.1.0') },
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: 'es2017',
      reportCompressedSize: false,
      lib: { entry: path.join(root, 'src/loader/index.ts'), formats: ['iife'], name: 'WrtmReviewWidget', fileName: () => 'widget.js' },
    },
  });

if (!watch) fs.rmSync(dist, { recursive: true, force: true });
const result = await build(appConfig);
if (watch) {
  result.on('event', async (e) => {
    if (e.code === 'BUNDLE_END') {
      e.result?.close?.();
      await buildLoader().catch((err) => console.error(err));
      console.log(`[widget] rebuilt ${new Date().toLocaleTimeString()}`);
    }
    if (e.code === 'ERROR') console.error(e.error);
  });
} else {
  await buildLoader();
  const { report } = await import('./size.mjs');
  report();
}
