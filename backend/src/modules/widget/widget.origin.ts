/**
 * Allowed-domain policy for the review widget.
 *
 * A website's widget only runs on its own host (the website URL, with or without "www.")
 * and on the hosts listed in Settings → Allowed domains ("app.example.com", "*.example.com",
 * "localhost"). Ports are ignored.
 *
 * This is an *installation* policy, not authentication: the Site ID is public and a
 * non-browser client can send any Origin header. Every data endpoint additionally
 * requires a signed-in user with access to the website.
 */

export const hostOfOrigin = (origin: string): string | null => {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
};

const stripWww = (h: string) => h.replace(/^www\./, '');

const matches = (host: string, pattern: string): boolean => {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return stripWww(host) === stripWww(p);
};

export const isOriginAllowed = (
  origin: string | undefined | null,
  website: { url: string },
  allowedDomains: readonly string[] = [],
): boolean => {
  if (!origin) return false;
  const host = hostOfOrigin(origin);
  if (!host) return false;
  const siteHost = hostOfOrigin(website.url);
  return [siteHost, ...allowedDomains].some((p) => p && matches(host, p));
};
