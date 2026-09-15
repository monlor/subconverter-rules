import { Env } from './types.js';
import { fetchFullIni, parseRuleSets, urlRuleSets } from './ini.js';
import { resolveLocalPath, ROOT } from './local-source.js';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { splitSubscriptions } from './cache.js';

const VENDOR_ROOT = join(ROOT, 'vendor') + '/';

interface RuleItem {
  label: string;
  url: string;
  source: 'repo' | 'vendor';
  path: string;
  present: boolean;
  mtime: string | null;
}

export async function handleStatus(
  env: Env,
  selfBase: string,
  authKey: string,
): Promise<Response> {
  const k = authKey ? `?key=${authKey}` : '';

  const clients = [
    { name: 'Shadowrocket', url: `${selfBase}/config${k}` },
    { name: 'Shadowrocket nodes (/sub)', url: `${selfBase}/sub${k}` },
    { name: 'Surge', url: `${selfBase}/config${k}${k ? '&' : '?'}target=surge` },
    { name: 'Clash / Mihomo', url: `${selfBase}/config${k}${k ? '&' : '?'}target=clash` },
  ];

  const subs = {
    PROXY_SUBS: splitSubscriptions(env.PROXY_SUBS).length,
    RELAY_SUBS: splitSubscriptions(env.RELAY_SUBS).length,
  };

  let rulesets: RuleItem[] = [];
  let iniError: string | null = null;
  try {
    const ini = await fetchFullIni(env);
    const urlOnly = urlRuleSets(parseRuleSets(ini));
    rulesets = urlOnly.map((rs, i) => {
      let path = '';
      let present = false;
      let mtime: string | null = null;
      let source: 'repo' | 'vendor' = 'repo';
      try {
        path = resolveLocalPath(rs.target);
        source = path.startsWith(VENDOR_ROOT) ? 'vendor' : 'repo';
        present = existsSync(path);
        if (present) mtime = statSync(path).mtime.toISOString();
      } catch {}
      return {
        label: `ruleset[${i + 1}] ${rs.policy}`,
        url: rs.target,
        source,
        path,
        present,
        mtime,
      };
    });
  } catch (e) {
    iniError = String(e);
  }

  const missing = rulesets.filter(r => !r.present).length;

  return new Response(
    JSON.stringify({
      mode: 'docker (all rules built into the image, no runtime GitHub access)',
      clients,
      subs,
      rulesets: {
        total: rulesets.length,
        missing,
        items: rulesets,
      },
      iniError,
    }, null, 2),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}
