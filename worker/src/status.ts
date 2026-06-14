import { Env, DEFAULT_REPO_BASE_URL } from './types.js';
import { cacheKey } from './cache.js';

const CACHE_TTL = 86400 * 30;

// Which items to refresh per scope
type RefreshScope = 'all' | 'shadowrocket' | 'surge' | 'clash' | 'sub';

const SCOPE_ALIASES: Record<string, RefreshScope> = {
  '1': 'all', 'all': 'all',
  'shadowrocket': 'shadowrocket', 'sr': 'shadowrocket',
  'surge': 'surge',
  'clash': 'clash', 'mihomo': 'clash', 'meta': 'clash',
  'sub': 'sub',
};

function inScope(label: string, scope: RefreshScope): boolean {
  if (scope === 'all') return true;
  if (scope === 'sub') return label.startsWith('PROXY_SUBS') || label.startsWith('RELAY_SUBS');
  const subLabels = label.startsWith('PROXY_SUBS') || label.startsWith('RELAY_SUBS');
  if (scope === 'shadowrocket') return label === 'full.ini' || label.includes('shadowrocket/template') || subLabels;
  if (scope === 'surge') return label === 'full.ini' || label.includes('template') || subLabels;
  if (scope === 'clash') return label === 'full.ini' || subLabels;
  return false;
}

interface CacheItem {
  label: string;
  url: string;
  cached: boolean;
  refreshed?: boolean;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function isCached(kv: KVNamespace, url: string): Promise<boolean> {
  const key = await cacheKey(url);
  return (await kv.get(key)) !== null;
}

async function tryRefresh(kv: KVNamespace, url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const text = await resp.text();
    await kv.put(await cacheKey(url), text, { expirationTtl: CACHE_TTL });
    return { ok: true };
  } catch (e) {
    // Cache is intentionally NOT touched on failure
    return { ok: false, error: String(e) };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleStatus(
  env: Env,
  selfBase: string,
  authKey: string,       // actual key from request (empty string if none)
  refreshParam: string | null,
): Promise<Response> {
  const k = authKey ? `?key=${authKey}` : '';
  const repoBase = (env.REPO_BASE_URL ?? DEFAULT_REPO_BASE_URL).replace(/\/?$/, '/');

  const clients = [
    { name: 'Shadowrocket', url: `${selfBase}/config${k}` },
    { name: 'Shadowrocket nodes (/sub)', url: `${selfBase}/sub${k}` },
    { name: 'Surge', url: `${selfBase}/config${k}${k ? '&' : '?'}target=surge` },
    { name: 'Clash / Mihomo', url: `${selfBase}/config${k}${k ? '&' : '?'}target=clash` },
  ];

  const scope: RefreshScope | null = refreshParam
    ? (SCOPE_ALIASES[refreshParam.toLowerCase()] ?? null)
    : null;

  const infraUrls = [
    { label: 'full.ini', url: repoBase + 'full.ini' },
    { label: 'shadowrocket/template.conf', url: repoBase + 'shadowrocket/template.conf' },
    { label: 'surge/template.conf', url: repoBase + 'surge/template.conf' },
  ];
  const subUrls = [
    ...(env.PROXY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      .map((u, i) => ({ label: `PROXY_SUBS[${i}]`, url: u })),
    ...(env.RELAY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      .map((u, i) => ({ label: `RELAY_SUBS[${i}]`, url: u })),
  ];
  const allUrls = [...infraUrls, ...subUrls];

  const kv = env.CACHE;
  let totalEntries: number | null = null;
  if (kv) {
    const list = await kv.list({ prefix: 'cache:' });
    totalEntries = list.keys.length;
  }

  const items: CacheItem[] = await Promise.all(
    allUrls.map(async ({ label, url }) => {
      if (!kv) return { label, url, cached: false };

      if (scope && inScope(label, scope)) {
        const { ok, error } = await tryRefresh(kv, url);
        const cached = ok || (await isCached(kv, url));
        return { label, url, cached, refreshed: ok, ...(error ? { error } : {}) };
      }

      return { label, url, cached: await isCached(kv, url) };
    }),
  );

  return new Response(
    JSON.stringify({ clients, cache: { totalEntries, items } }, null, 2),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}
