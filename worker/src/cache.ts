const CACHE_TTL = 86400 * 30;

export async function getSubContent(
  kv: KVNamespace | undefined,
  sub: string,
  force = false,
): Promise<string | null> {
  if (!sub.startsWith('http://') && !sub.startsWith('https://')) {
    return sub.trim() || null;
  }
  return cachedFetch(kv, sub, force);
}

export async function cachedFetch(
  kv: KVNamespace | undefined,
  url: string,
  force = false,
): Promise<string | null> {
  let fresh: string | null = null;
  let ok = false;

  try {
    const resp = await fetch(url);
    if (resp.ok) { fresh = await resp.text(); ok = true; }
  } catch {}

  if (ok && fresh !== null) {
    if (kv) {
      const key = await cacheKey(url);
      await kv.put(key, fresh, { expirationTtl: CACHE_TTL });
    }
    return fresh;
  }

  if (!force && kv) {
    const key = await cacheKey(url);
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

async function cacheKey(url: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return 'cache:' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
