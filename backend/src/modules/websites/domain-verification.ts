import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../../config/env';

/**
 * Domain ownership verification: fetches the website's home page and looks for either
 *   <meta name="wrtm-site-verification" content="<verificationToken>">   or
 *   the embed script tag with data-site-id="<siteId>".
 *
 * SSRF protection: only http(s), at most 3 redirects, each hop re-validated, 8 s timeout,
 * 1 MB body cap, and (unless ALLOW_PRIVATE_NETWORK_FETCH) private/loopback addresses are refused.
 */

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

const isPrivateIp = (ip: string): boolean => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
};

const assertPublicHost = async (url: URL) => {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs can be verified');
  if (env.ALLOW_PRIVATE_NETWORK_FETCH) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new Error('The website address resolves to a private network and cannot be verified');
  }
};

const readCapped = async (res: Response): Promise<string> => {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8');
};

export const fetchHomepage = async (rawUrl: string): Promise<{ finalUrl: string; html: string }> => {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'WebsiteReviewBot/1.0 (+domain verification)', accept: 'text/html' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new Error(`The website responded with HTTP ${res.status}`);
    return { finalUrl: url.toString(), html: await readCapped(res) };
  }
  throw new Error('Too many redirects');
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const findVerificationMarker = (
  html: string,
  { siteId, verificationToken }: { siteId: string; verificationToken: string },
): 'meta_tag' | 'embed_script' | null => {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const metaOk = metaTags.some(
    (tag) =>
      /name\s*=\s*["']wrtm-site-verification["']/i.test(tag) &&
      new RegExp(`content\\s*=\\s*["']${escapeRe(verificationToken)}["']`).test(tag),
  );
  if (metaOk) return 'meta_tag';
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  const scriptOk = scripts.some((tag) => new RegExp(`data-site-id\\s*=\\s*["']${escapeRe(siteId)}["']`).test(tag));
  return scriptOk ? 'embed_script' : null;
};
