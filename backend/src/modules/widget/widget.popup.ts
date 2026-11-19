import crypto from 'node:crypto';
import type { Response } from 'express';

/**
 * Final page of the widget's Google sign-in popup. It hands the result to the widget with
 * window.opener.postMessage(), restricted to the origin that was validated against the
 * website's allowed domains when the flow started, then closes itself.
 */
export const renderWidgetAuthResult = (res: Response, targetOrigin: string, payload: Record<string, unknown>) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  // JSON inside <script type="application/json">: escape "<" so the data can't close the tag.
  const data = JSON.stringify({ type: 'wrtm:auth', ...payload }).replace(/</g, '\\u003c');
  const origin = JSON.stringify(targetOrigin).replace(/</g, '\\u003c');
  const ok = payload.ok === true;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${ok ? 'Signed in' : 'Sign-in failed'}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">body{font:15px/1.5 system-ui,sans-serif;color:#334155;display:grid;place-items:center;min-height:90vh;margin:0}</style>
</head><body><p>${ok ? 'Signed in. You can close this window.' : 'Sign-in failed. You can close this window and try again.'}</p>
<script type="application/json" id="wrtm-data">${data}</script>
<script nonce="${nonce}">
(function () {
  var data = JSON.parse(document.getElementById('wrtm-data').textContent);
  try { if (window.opener) window.opener.postMessage(data, ${origin}); } catch (e) {}
  setTimeout(function () { window.close(); }, 50);
})();
</script></body></html>`;
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      // The popup must keep its opener to post the result back.
      'Cross-Origin-Opener-Policy': 'unsafe-none',
      'Referrer-Policy': 'no-referrer',
    })
    .send(html);
};
