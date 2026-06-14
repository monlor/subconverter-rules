import { RuleSet, ProxyGroup, Env, DEFAULT_REPO_BASE_URL } from './types.js';
import { cachedFetch } from './cache.js';

function repoBase(env: Env): string {
  return (env.REPO_BASE_URL ?? DEFAULT_REPO_BASE_URL).replace(/\/?$/, '/');
}

export async function fetchFullIni(env: Env, force = false): Promise<string> {
  const url = repoBase(env) + 'full.ini';
  const text = await cachedFetch(env.CACHE, url, force);
  if (!text) throw new Error(`Failed to fetch full.ini from ${url}`);
  return text;
}

export async function fetchRepoFile(env: Env, path: string, force = false): Promise<string> {
  const url = repoBase(env) + path;
  const text = await cachedFetch(env.CACHE, url, force);
  if (!text) throw new Error(`Failed to fetch ${path} from ${url}`);
  return text;
}

export function parseRuleSets(ini: string): RuleSet[] {
  const rulesets: RuleSet[] = [];
  for (const raw of ini.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (!line.startsWith('ruleset=')) continue;

    const payload = line.slice('ruleset='.length);
    const parts = payload.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    let target = parts[1];
    let options: string[] = parts.slice(2);
    if (target.startsWith('[]')) {
      target = parts.slice(1).join(',');
      options = [];
    }
    rulesets.push({ policy: parts[0], target, options });
  }
  return rulesets;
}

export function parseProxyGroups(ini: string): ProxyGroup[] {
  const groups: ProxyGroup[] = [];
  for (const raw of ini.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (!line.startsWith('custom_proxy_group=')) continue;

    const payload = line.slice('custom_proxy_group='.length);
    const parts = payload.split('`').map(p => p.trim());
    if (parts.length < 2) continue;
    groups.push({ name: parts[0], groupType: parts[1], items: parts.slice(2) });
  }
  return groups;
}

/** URL-typed rulesets only (excludes [] inline rules), in order. */
export function urlRuleSets(rulesets: RuleSet[]): RuleSet[] {
  return rulesets.filter(r => !r.target.startsWith('[]'));
}
