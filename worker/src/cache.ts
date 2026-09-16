const CACHE_TTL = 86400 * 30;
const USERINFO_TTL = 3600;
const DEFAULT_SUB_CACHE_TTL = 3600;
const GH_PROXY = 'https://gh.monlor.com/';

// Common UA recognized by most airports for returning Subscription-Userinfo header
const SUB_UA = 'ClashForAndroid/2.5.12';

/** Strip gh.monlor.com proxy prefix so the Worker fetches GitHub directly. */
function normalizeUrl(url: string): string {
  return url.startsWith(GH_PROXY) ? url.slice(GH_PROXY.length) : url;
}

export function parseSubCacheTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SUB_CACHE_TTL;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SUB_CACHE_TTL;
  return Math.floor(n);
}

function subFreshKey(key: string): string {
  return 'subfresh:' + key.slice(6);
}

export async function getSubContent(
  kv: KVNamespace | undefined,
  sub: string,
  force = false,
  ttl = DEFAULT_SUB_CACHE_TTL,
): Promise<string | null> {
  if (!sub.startsWith('http://') && !sub.startsWith('https://')) {
    return sub.trim() || null;
  }
  return fetchSubscription(kv, sub, force, ttl);
}

async function fetchSubscription(
  kv: KVNamespace | undefined,
  url: string,
  force: boolean,
  ttl: number,
): Promise<string | null> {
  const fetchUrl = normalizeUrl(url);
  const key = await cacheKey(fetchUrl);
  const fKey = subFreshKey(key);

  if (!force && kv && ttl > 0) {
    const [cached, fetchedAt] = await Promise.all([kv.get(key), kv.get(fKey)]);
    if (cached !== null && fetchedAt !== null) {
      const age = Date.now() / 1000 - Number(fetchedAt);
      if (Number.isFinite(age) && age < ttl) return cached;
    }
  }

  let fresh: string | null = null;
  let uiHeader: string | null = null;
  let ok = false;

  try {
    const resp = await fetch(fetchUrl);
    if (resp.ok) {
      uiHeader = resp.headers.get('subscription-userinfo');
      fresh = await resp.text();
      ok = true;
    }
  } catch {}

  if (ok && fresh !== null) {
    if (kv) {
      await kv.put(key, fresh);
      await kv.put(fKey, String(Math.floor(Date.now() / 1000)));
      if (uiHeader) {
        await kv.put('userinfo:' + key.slice(6), uiHeader, { expirationTtl: USERINFO_TTL });
      }
    }
    return fresh;
  }

  if (kv) {
    const cached = await kv.get(key);
    if (cached !== null) return cached;
  }

  return null;
}

export async function cachedFetch(
  kv: KVNamespace | undefined,
  url: string,
  _force = false,
): Promise<string | null> {
  const fetchUrl = normalizeUrl(url);
  let fresh: string | null = null;
  let uiHeader: string | null = null;
  let ok = false;

  try {
    const resp = await fetch(fetchUrl);
    if (resp.ok) {
      uiHeader = resp.headers.get('subscription-userinfo');
      fresh = await resp.text();
      ok = true;
    }
  } catch {}

  if (ok && fresh !== null) {
    if (kv) {
      const key = await cacheKey(fetchUrl);
      await kv.put(key, fresh, { expirationTtl: CACHE_TTL });
      if (uiHeader) {
        await kv.put('userinfo:' + key.slice(6), uiHeader, { expirationTtl: USERINFO_TTL });
      }
    }
    return fresh;
  }

  if (kv) {
    const key = await cacheKey(fetchUrl);
    const cached = await kv.get(key);
    if (cached !== null) return cached;
  }

  return null;
}

export function decodeBase64(text: string): string | null {
  try {
    const cleaned = text.trim().replace(/\s+/g, '');
    const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = atob(padded);
    return decoded.includes('://') ? decoded : null;
  } catch {
    return null;
  }
}

/** Fetch all sub URLs, decode base64, return raw URI lines. */
export async function fetchSubLines(
  kv: KVNamespace | undefined,
  subs: string,
  force = false,
  ttl = DEFAULT_SUB_CACHE_TTL,
): Promise<string[]> {
  const lines: string[] = [];
  for (const sub of subs.split(',').map(s => s.trim()).filter(Boolean)) {
    const text = await getSubContent(kv, sub, force, ttl);
    if (!text) continue;
    const content = decodeBase64(text) ?? text;
    for (const line of content.split(/[\r\n]+/)) {
      const t = line.trim();
      if (t.includes('://')) lines.push(t);
    }
  }
  return lines;
}

export async function cacheKey(url: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return 'cache:' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get Subscription-Userinfo for the first URL in a comma-separated subs string.
 * Reads from KV cache (populated by cachedFetch); falls back to a direct fetch
 * with a known User-Agent so airports return the header.
 */
export async function fetchUserinfo(
  kv: KVNamespace | undefined,
  subsStr: string,
  force = false,
): Promise<string | null> {
  const firstUrl = subsStr.split(',').map(s => s.trim()).find(Boolean);
  if (!firstUrl || (!firstUrl.startsWith('http://') && !firstUrl.startsWith('https://'))) return null;

  const fetchUrl = normalizeUrl(firstUrl);
  const key = await cacheKey(fetchUrl);
  const kvKey = 'userinfo:' + key.slice(6);

  if (!force && kv) {
    const cached = await kv.get(kvKey);
    if (cached !== null) return cached || null;
  }

  // Direct fetch with recognized UA so airport returns the Subscription-Userinfo header
  try {
    const resp = await fetch(fetchUrl, { headers: { 'User-Agent': SUB_UA } });
    if (resp.ok) {
      const userinfo = resp.headers.get('subscription-userinfo');
      if (userinfo) {
        if (kv) await kv.put(kvKey, userinfo, { expirationTtl: USERINFO_TTL });
        return userinfo;
      }
      // Cache empty sentinel so we don't keep retrying when airport has no userinfo
      if (kv) await kv.put(kvKey, '', { expirationTtl: USERINFO_TTL });
    }
  } catch {}

  // Fall back to stale KV value if available
  if (kv) {
    const cached = await kv.get(kvKey);
    if (cached) return cached;
  }

  return null;
}
