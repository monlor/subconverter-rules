import { Env, DEFAULT_REPO_BASE_URL } from './types.js';
import { cacheKey } from './cache.js';

const CACHE_TTL = 86400 * 30;

interface CacheItem {
  label: string;
  url: string;
  cached: boolean;
  refreshed?: boolean;   // present only when refresh attempted
  error?: string;        // present only when refresh failed
}

interface StatusResult {
  clients: { name: string; url: string }[];
  cache: {
    totalEntries: number | null;  // total KV keys (may be null if KV unavailable)
    items: CacheItem[];
  };
}

// ─── Cache check (no content download) ───────────────────────────────────────

async function isCached(kv: KVNamespace, url: string): Promise<boolean> {
  const key = await cacheKey(url);
  const value = await kv.get(key);
  return value !== null;
}

// ─── Refresh one URL: fetch → write KV on success, keep cache on failure ─────

async function tryRefresh(kv: KVNamespace, url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const text = await resp.text();
    const key = await cacheKey(url);
    await kv.put(key, text, { expirationTtl: CACHE_TTL });
    return { ok: true };
  } catch (e) {
    // Network or timeout error — cache is intentionally NOT touched
    return { ok: false, error: String(e) };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleStatus(
  env: Env,
  selfBase: string,
  refresh: boolean,
): Promise<Response> {
  const key = env.SECRET_KEY ? `KEY` : '';   // placeholder in URLs shown
  const repoBase = (env.REPO_BASE_URL ?? DEFAULT_REPO_BASE_URL).replace(/\/?$/, '/');

  const clients = [
    { name: 'Shadowrocket', url: `${selfBase}/config?key=${key}` },
    { name: 'Shadowrocket nodes (/sub)', url: `${selfBase}/sub?key=${key}` },
    { name: 'Surge', url: `${selfBase}/config?key=${key}&target=surge` },
    { name: 'Clash / Mihomo', url: `${selfBase}/config?key=${key}&target=clash` },
  ];

  // URLs to track
  const infraUrls: { label: string; url: string }[] = [
    { label: 'full.ini', url: repoBase + 'full.ini' },
    { label: 'shadowrocket/lazy_group.conf', url: repoBase + 'shadowrocket/lazy_group.conf' },
    { label: 'surge/template.conf', url: repoBase + 'surge/template.conf' },
  ];

  const proxySubs = (env.PROXY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const relaySubs = (env.RELAY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const subUrls: { label: string; url: string }[] = [
    ...proxySubs.map((u, i) => ({ label: `PROXY_SUBS[${i}]`, url: u })),
    ...relaySubs.map((u, i) => ({ label: `RELAY_SUBS[${i}]`, url: u })),
  ];

  const allUrls = [...infraUrls, ...subUrls];

  const kv = env.CACHE;

  // Total KV entries
  let totalEntries: number | null = null;
  if (kv) {
    const list = await kv.list({ prefix: 'cache:' });
    totalEntries = list.keys.length;
  }

  // Build cache items
  const items: CacheItem[] = await Promise.all(
    allUrls.map(async ({ label, url }) => {
      if (!kv) return { label, url, cached: false };

      if (refresh) {
        const { ok, error } = await tryRefresh(kv, url);
        // After refresh attempt, check if the entry is now cached
        // (it was either just refreshed, or still has old cache, or never existed)
        const cached = ok || (await isCached(kv, url));
        return { label, url, cached, refreshed: ok, ...(error ? { error } : {}) };
      }

      const cached = await isCached(kv, url);
      return { label, url, cached };
    }),
  );

  const result: StatusResult = {
    clients,
    cache: { totalEntries, items },
  };

  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
