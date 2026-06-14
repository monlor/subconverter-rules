import { Env, DEFAULT_REPO_BASE_URL } from './types.js';
import { cacheKey } from './cache.js';
import { fetchFullIni, parseRuleSets, urlRuleSets } from './ini.js';

const GH_PROXY = 'https://gh.monlor.com/';

function normalizeUrl(url: string): string {
  return url.startsWith(GH_PROXY) ? url.slice(GH_PROXY.length) : url;
}

function rulesetFilename(url: string): string {
  return url.split('/').pop() ?? url;
}

async function isCached(kv: KVNamespace, url: string): Promise<boolean> {
  const key = await cacheKey(normalizeUrl(url));
  return (await kv.get(key)) !== null;
}

interface CacheItem {
  label: string;
  url: string;
  cached: boolean;
}

export async function handleStatus(
  env: Env,
  selfBase: string,
  authKey: string,
): Promise<Response> {
  const k = authKey ? `?key=${authKey}` : '';
  const repoBase = (env.REPO_BASE_URL ?? DEFAULT_REPO_BASE_URL).replace(/\/?$/, '/');

  const clients = [
    { name: 'Shadowrocket', url: `${selfBase}/config${k}` },
    { name: 'Shadowrocket nodes (/sub)', url: `${selfBase}/sub${k}` },
    { name: 'Surge', url: `${selfBase}/config${k}${k ? '&' : '?'}target=surge` },
    { name: 'Clash / Mihomo', url: `${selfBase}/config${k}${k ? '&' : '?'}target=clash` },
  ];

  const infraUrls: { label: string; url: string }[] = [
    { label: 'full.ini', url: repoBase + 'full.ini' },
    { label: 'shadowrocket/template.conf', url: repoBase + 'shadowrocket/template.conf' },
    { label: 'surge/template.conf', url: repoBase + 'surge/template.conf' },
  ];

  const subUrls: { label: string; url: string }[] = [
    ...(env.PROXY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      .map((u, i) => ({ label: `PROXY_SUBS[${i}]`, url: u })),
    ...(env.RELAY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      .map((u, i) => ({ label: `RELAY_SUBS[${i}]`, url: u })),
  ];

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
      return { label, url: displayUrl, cached: await isCached(kv, url) };
    }),
  );

  return new Response(
    JSON.stringify({ clients, cache: { totalEntries, items } }, null, 2),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}
