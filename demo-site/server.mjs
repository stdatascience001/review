// Demo customer website for testing the review widget — a separate site on its own origin.
//
//   SITE_ID=site_xxx node demo-site/server.mjs          → http://127.0.0.1:5600
//
// Env: PORT (5600), HOST (127.0.0.1), WIDGET_SRC (http://localhost:4000/widget.js), SITE_ID.
// The pages contain the embed snippet with {{WIDGET_SRC}} / {{SITE_ID}} filled in.
// DEMO_ALLOW_CONFIG=1 enables POST /__demo/config {siteId, widgetSrc, host?} (used by the e2e tests).
// With "host" (e.g. "localhost:5600") the setting applies only to requests for that host, so
// 127.0.0.1:5600 and localhost:5600 can act as two different customer websites.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT ?? 5600);
const host = process.env.HOST ?? '127.0.0.1';
const config = {
  widgetSrc: process.env.WIDGET_SRC ?? 'http://localhost:4000/widget.js',
  siteId: process.env.SITE_ID ?? 'site_00000000000000000000',
};
/** Per-host overrides: { "localhost:5600": { siteId, widgetSrc } } */
const hostConfig = new Map();
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/__demo/config' && req.method === 'POST' && process.env.DEMO_ALLOW_CONFIG === '1') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { host: forHost, reset, ...settings } = JSON.parse(body || '{}');
      if (forHost && reset) hostConfig.delete(forHost);
      else if (forHost) hostConfig.set(forHost, { ...hostConfig.get(forHost), ...settings });
      else Object.assign(config, settings);
      res.writeHead(204).end();
    });
    return;
  }

  // SPA: every /app/* path serves the single-page app shell (client-side routing).
  let file = url.pathname.startsWith('/app') ? '/app.html' : url.pathname === '/' ? '/index.html' : url.pathname;
  if (!path.extname(file)) file += '.html';
  const full = path.join(root, path.normalize(file));
  if (!full.startsWith(root) || !fs.existsSync(full)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const ext = path.extname(full);
  let content = fs.readFileSync(full);
  const site = { ...config, ...hostConfig.get(req.headers.host) };
  if (ext === '.html') {
    content = content
      .toString('utf8')
      .replaceAll('{{WIDGET_SRC}}', escape(site.widgetSrc))
      .replaceAll('{{SITE_ID}}', escape(site.siteId));
  }
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(content);
});

server.listen(port, host, () => console.log(`Demo site: http://${host}:${port}  (widget ${config.widgetSrc}, site ${config.siteId})`));
