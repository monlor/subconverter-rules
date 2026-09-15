import { RuleSet, ProxyGroup, Env } from './types.js';
import { readFullIni, readRepoFile } from './local-source.js';

export async function fetchFullIni(_env: Env, _force = false): Promise<string> {
  return readFullIni();
}

export async function fetchRepoFile(_env: Env, path: string, _force = false): Promise<string> {
  return readRepoFile(path);
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

export function urlRuleSets(rulesets: RuleSet[]): RuleSet[] {
  return rulesets.filter(r => !r.target.startsWith('[]'));
}

export function rulesetSlug(url: string): string {
  const filename = url.split('/').pop() ?? '';
  return filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
