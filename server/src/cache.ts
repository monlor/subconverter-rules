import { MemoryKV } from './memory-kv.js';
import { normalizeUrl } from './local-source.js';

const USERINFO_TTL = 3600;
const DEFAULT_SUB_CACHE_TTL = 3600;

const SUB_UA = 'Shadowrocket/2592';

const PROXY_URI =
  /(?:^|[\n\r])[ \t]*(?:ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|wireguard|anytls|juicity):\/\//i;

export type SubscriptionFetchOutcome = 'success' | 'http_error' | 'network_error' | 'empty_body' | 'no_proxy_uri';

export interface SubscriptionDiagnostic {
  lastAttemptAt: string;
  outcome: SubscriptionFetchOutcome;
  cached: boolean;
  httpStatus?: number;
  errorType?: string;
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

function subDiagnosticKey(key: string): string {
  return 'subdiagnostic:' + key.slice(6);
}

function decodeBase64Utf8(padded: string): string {
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export function decodeBase64(text: string): string | null {
  try {
    const cleaned = text.trim().replace(/\s+/g, '');
    const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = decodeBase64Utf8(padded);
    return decoded.includes('://') ? decoded : null;
  } catch {
    return null;
  }
}

/** True when the body contains at least one proxy URI (plaintext or base64). */
export function isUsableSubBody(text: string): boolean {
  if (!text || !text.trim()) return false;
  const content = decodeBase64(text) ?? text;
  return PROXY_URI.test(content);
}

export async function getSubContent(
  kv: MemoryKV,
  sub: string,
  force = false,
  ttl = DEFAULT_SUB_CACHE_TTL,
  source = 'subscription',
): Promise<string | null> {
  if (!sub.startsWith('http://') && !sub.startsWith('https://')) {
    return sub.trim() || null;
  }
  return cachedFetch(kv, sub, force, ttl, source);
}

export async function cachedFetch(
  kv: MemoryKV,
  url: string,
  force = false,
  ttl = DEFAULT_SUB_CACHE_TTL,
  source = 'subscription',
): Promise<string | null> {
  const fetchUrl = normalizeUrl(url);
  const key = await cacheKey(fetchUrl);
  const fKey = subFreshKey(key);

  if (!force && ttl > 0) {
    const [cached, fetchedAt] = await Promise.all([kv.get(key), kv.get(fKey)]);
    if (cached !== null && fetchedAt !== null) {
      const age = Date.now() / 1000 - Number(fetchedAt);
      if (Number.isFinite(age) && age < ttl) return cached;
    }
  }

  let fresh: string | null = null;
  let uiHeader: string | null = null;
  let outcome: SubscriptionFetchOutcome = 'network_error';
  let httpStatus: number | undefined;
  let errorType: string | undefined;

  try {
    const resp = await fetch(fetchUrl, { headers: { 'User-Agent': SUB_UA } });
    httpStatus = resp.status;
    if (!resp.ok) {
      outcome = 'http_error';
    } else {
      uiHeader = resp.headers.get('subscription-userinfo');
      fresh = await resp.text();
      outcome = !fresh.trim() ? 'empty_body' : isUsableSubBody(fresh) ? 'success' : 'no_proxy_uri';
    }
  } catch (error) {
    errorType = error instanceof Error ? error.name : 'Error';
  }

  if (outcome === 'success' && fresh !== null) {
    await kv.put(key, fresh);
    await kv.put(fKey, String(Math.floor(Date.now() / 1000)));
    if (uiHeader) {
      await kv.put('userinfo:' + key.slice(6), uiHeader, { expirationTtl: USERINFO_TTL });
    }
  }

  const cached = await kv.get(key);
  const diagnostic: SubscriptionDiagnostic = {
    lastAttemptAt: new Date().toISOString(),
    outcome,
    cached: cached !== null,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(errorType === undefined ? {} : { errorType }),
  };
  await kv.put(subDiagnosticKey(key), JSON.stringify(diagnostic));

  if (outcome === 'success') return fresh;

  // Keep subscription credentials out of logs; source is only a configured group and index.
  console.warn('subhub: subscription fetch failed', { source, ...diagnostic });
  if (cached !== null) {
    return cached;
  }

  return null;
}

export async function fetchSubLines(
  kv: MemoryKV,
  subs: string,
  force = false,
  ttl = DEFAULT_SUB_CACHE_TTL,
  source = 'subscription',
): Promise<string[]> {
  const lines: string[] = [];
  for (const [index, sub] of splitSubscriptions(subs).entries()) {
    const text = await getSubContent(kv, sub, force, ttl, `${source}[${index + 1}]`);
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

export async function getSubscriptionDiagnostic(
  kv: MemoryKV,
  url: string,
): Promise<SubscriptionDiagnostic | null> {
  const value = await kv.get(subDiagnosticKey(await cacheKey(normalizeUrl(url))));
  if (!value) return null;
  try {
    const diagnostic = JSON.parse(value) as SubscriptionDiagnostic;
    if (!diagnostic || typeof diagnostic.lastAttemptAt !== 'string' || typeof diagnostic.outcome !== 'string') return null;
    return diagnostic;
  } catch {
    return null;
  }
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
