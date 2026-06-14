import { Env, DEFAULT_REPO_BASE_URL } from './types.js';
import { cacheKey } from './cache.js';
import { fetchFullIni, parseRuleSets, urlRuleSets } from './ini.js';

const CACHE_TTL = 86400 * 30;
const GH_PROXY = 'https://gh.monlor.com/';

function normalizeUrl(url: string): string {
  return url.startsWith(GH_PROXY) ? url.slice(GH_PROXY.length) : url;
}

function rulesetFilename(url: string): string {
  return url.split('/').pop() ?? url;
}

// ─── Scope ────────────────────────────────────────────────────────────────────

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
  const isSub = label.startsWith('PROXY_SUBS') || label.startsWith('RELAY_SUBS');
  const isRuleset = label.startsWith('ruleset[');
  if (scope === 'sub') return isSub;
  if (scope === 'shadowrocket') return label === 'full.ini' || label.includes('shadowrocket/template') || isSub || isRuleset;
  if (scope === 'surge') return label === 'full.ini' || label.includes('surge/template') || isSub || isRuleset;
  if (scope === 'clash') return label === 'full.ini' || isSub; // Clash fetches rule-providers directly, no worker ruleset cache
  return false;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function isCached(kv: KVNamespace, url: string): Promise<boolean> {
  const key = await cacheKey(normalizeUrl(url));
  return (await kv.get(key)) !== null;
}

async function tryRefreshUrl(kv: KVNamespace, url: string): Promise<{ ok: boolean; error?: string }> {
  const fetchUrl = normalizeUrl(url);
  try {
    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const text = await resp.text();
    await kv.put(await cacheKey(fetchUrl), text, { expirationTtl: CACHE_TTL });
    return { ok: true };
  } catch (e) {
    // Cache is intentionally NOT touched on failure
    return { ok: false, error: String(e) };
  }
}

/** After refreshing a ruleset's raw cache, delete the converted caches so they
 *  are rebuilt on the next /ruleset/N request. */
async function invalidateConvertedCaches(kv: KVNamespace, url: string, scope: RefreshScope): Promise<void> {
  const targets = scope === 'all'
    ? ['shadowrocket', 'surge']
    : scope === 'surge' || scope === 'shadowrocket'
      ? [scope]
      : [];
  for (const t of targets) {
    await kv.delete(`ruleset:${t}:${url}`);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

interface CacheItem {
  label: string;
  url: string;
  cached: boolean;
  refreshed?: boolean;
  error?: string;
}

export async function handleStatus(
  env: Env,
  selfBase: string,
  authKey: string,
  refreshParam: string | null,
): Promise<Response> {
  const k = authKey ? `?key=${authKey}` : '';
  const repoBase = (env.REPO_BASE_URL ?? DEFAULT_REPO_BASE_URL).replace(/\/?$/, '/');
  const scope: RefreshScope | null = refreshParam
    ? (SCOPE_ALIASES[refreshParam.toLowerCase()] ?? null)
    : null;

  const clients = [
    { name: 'Shadowrocket', url: `${selfBase}/config${k}` },
    { name: 'Shadowrocket nodes (/sub)', url: `${selfBase}/sub${k}` },
    { name: 'Surge', url: `${selfBase}/config${k}${k ? '&' : '?'}target=surge` },
    { name: 'Clash / Mihomo', url: `${selfBase}/config${k}${k ? '&' : '?'}target=clash` },
  ];

  // ── Infrastructure files ──
  const infraUrls: { label: string; url: string }[] = [
    { label: 'full.ini', url: repoBase + 'full.ini' },
    { label: 'shadowrocket/template.conf', url: repoBase + 'shadowrocket/template.conf' },
    { label: 'surge/template.conf', url: repoBase + 'surge/template.conf' },
  ];

  // ── Subscription URLs ──
  const subUrls: { label: string; url: string }[] = [
    ...(env.PROXY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      .map((u, i) => ({ label: `PROXY_SUBS[${i}]`, url: u })),
    ...(env.RELAY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      .map((u, i) => ({ label: `RELAY_SUBS[${i}]`, url: u })),
  ];

  // ── Ruleset URLs (from full.ini) ──
  let rulesetUrls: { label: string; url: string }[] = [];
  try {
    const ini = await fetchFullIni(env);
    const all = parseRuleSets(ini);
    const urlOnly = urlRuleSets(all);
    rulesetUrls = urlOnly.map((rs, i) => ({
      label: `ruleset[${i + 1}] ${rs.policy} (${rulesetFilename(rs.target)})`,
      url: rs.target,
    }));
  } catch {}

  const allUrls = [...infraUrls, ...subUrls, ...rulesetUrls];

  const kv = env.CACHE;
  let totalEntries: number | null = null;
  if (kv) {
    const list = await kv.list({ prefix: 'cache:' });
    totalEntries = list.keys.length;
  }

  const items: CacheItem[] = await Promise.all(
    allUrls.map(async ({ label, url }) => {
      const displayUrl = normalizeUrl(url);
      if (!kv) return { label, url: displayUrl, cached: false };

      if (scope && inScope(label, scope)) {
        const { ok, error } = await tryRefreshUrl(kv, url);
        // On success, invalidate converted ruleset caches so they're rebuilt on next request
        if (ok && label.startsWith('ruleset[')) {
          await invalidateConvertedCaches(kv, url, scope);
        }
        const cached = ok || (await isCached(kv, url));
        return { label, url: displayUrl, cached, refreshed: ok, ...(error ? { error } : {}) };
      }

      return { label, url: displayUrl, cached: await isCached(kv, url) };
    }),
  );

  return new Response(
    JSON.stringify({ clients, cache: { totalEntries, items } }, null, 2),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}
