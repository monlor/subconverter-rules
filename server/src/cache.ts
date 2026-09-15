import { MemoryKV } from './memory-kv.js';
import { normalizeUrl } from './local-source.js';

const CACHE_TTL = 86400 * 30;
const USERINFO_TTL = 3600;

const SUB_UA = 'ClashForAndroid/2.5.12';

export async function getSubContent(
  kv: MemoryKV,
  sub: string,
  force = false,
): Promise<string | null> {
  if (!sub.startsWith('http://') && !sub.startsWith('https://')) {
    return sub.trim() || null;
  }
  return cachedFetch(kv, sub, force);
}

export async function cachedFetch(
  kv: MemoryKV,
  url: string,
  force = false,
): Promise<string | null> {
  const fetchUrl = normalizeUrl(url);
  const key = await cacheKey(fetchUrl);

  if (!force) {
    const cached = await kv.get(key);
    if (cached !== null) return cached;
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
    await kv.put(key, fresh, { expirationTtl: CACHE_TTL });
    if (uiHeader) {
      await kv.put('userinfo:' + key.slice(6), uiHeader, { expirationTtl: USERINFO_TTL });
    }
    return fresh;
  }

  const cached = await kv.get(key);
  if (cached !== null) return cached;

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

export async function fetchSubLines(
  kv: MemoryKV,
  subs: string,
  force = false,
): Promise<string[]> {
  const lines: string[] = [];
  for (const sub of splitSubscriptions(subs)) {
    const text = await getSubContent(kv, sub, force);
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

export async function fetchUserinfo(
  kv: MemoryKV,
  subsStr: string,
  force = false,
): Promise<string | null> {
  const firstUrl = splitSubscriptions(subsStr)[0];
  if (!firstUrl || (!firstUrl.startsWith('http://') && !firstUrl.startsWith('https://'))) return null;

  const fetchUrl = normalizeUrl(firstUrl);
  const key = await cacheKey(fetchUrl);
  const kvKey = 'userinfo:' + key.slice(6);

  if (!force) {
    const cached = await kv.get(kvKey);
    if (cached !== null) return cached || null;
  }

  try {
    const resp = await fetch(fetchUrl, { headers: { 'User-Agent': SUB_UA } });
    if (resp.ok) {
      const userinfo = resp.headers.get('subscription-userinfo');
      if (userinfo) {
        await kv.put(kvKey, userinfo, { expirationTtl: USERINFO_TTL });
        return userinfo;
      }
      await kv.put(kvKey, '', { expirationTtl: USERINFO_TTL });
    }
  } catch {}

  const cached = await kv.get(kvKey);
  if (cached) return cached;

  return null;
}

export function splitSubscriptions(raw: string | undefined): string[] {
  return (raw ?? '').split(/[,\r\n]+/).map(s => s.trim()).filter(Boolean);
}
