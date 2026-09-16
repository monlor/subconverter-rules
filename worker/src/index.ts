import { Env, ClientTarget } from './types.js';
import { generateSub } from './sub.js';
import { generateShadowrocket } from './shadowrocket.js';
import { generateSurge } from './surge.js';
import { generateClash } from './clash.js';
import { handleRuleset } from './ruleset.js';
import { handleStatus } from './status.js';
import { parseRuleSets, urlRuleSets, fetchFullIni } from './ini.js';
import { fetchUserinfo } from './cache.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const selfBase = `${url.protocol}//${url.host}`;
    const key = url.searchParams.get('key');
    const force = url.searchParams.get('force') === '1';
    const infoType = url.searchParams.get('info') === 'relay' ? 'relay' : 'proxy';

    // /ruleset/:index[-name] is public (no auth)
    const rulesetMatch = url.pathname.match(/^\/ruleset\/(\d+)(?:-[^/?]*)?$/);
    if (rulesetMatch) {
      return handleRulesetRequest(env, parseInt(rulesetMatch[1], 10), url, force);
    }

    // All other endpoints require auth
    if (env.SECRET_KEY && key !== env.SECRET_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (url.pathname === '/sub') return handleSub(env, force, infoType);
    if (url.pathname === '/config') return handleConfig(env, selfBase, request, url, force, infoType);
    if (url.pathname === '/status') {
      return handleStatus(env, selfBase, key ?? '');
    }

    return new Response(helpText(selfBase), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

// ─── /sub ────────────────────────────────────────────────────────────────────

async function handleSub(env: Env, force: boolean, infoType: 'relay' | 'proxy'): Promise<Response> {
  try {
    const [sub, userinfo] = await Promise.all([
      generateSub(env, force),
      fetchUserinfo(env.CACHE, infoType === 'proxy' ? env.PROXY_SUBS : env.RELAY_SUBS, force),
    ]);
    return new Response(sub, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="MySub.txt"',
        'Subscription-Userinfo': userinfo ?? 'upload=0; download=0; total=107374182400; expire=99999999999',
      },
    });
  } catch (e) {
    return new Response(`Error: ${String(e)}`, { status: 500 });
  }
}

// ─── /config ─────────────────────────────────────────────────────────────────

function detectTarget(request: Request, url: URL): ClientTarget {
  const override = url.searchParams.get('target')?.toLowerCase();
  if (override === 'shadowrocket' || override === 'sr') return 'shadowrocket';
  if (override === 'surge') return 'surge';
  if (override === 'clash') return 'clash';

  const ua = request.headers.get('User-Agent') ?? '';
  if (/Shadowrocket/i.test(ua)) return 'shadowrocket';
  if (/Surge/i.test(ua)) return 'surge';
  if (/clash|mihomo|stash|meta/i.test(ua)) return 'clash';
  return 'shadowrocket';
}

async function handleConfig(
  env: Env,
  selfBase: string,
  request: Request,
  url: URL,
  force: boolean,
  infoType: 'relay' | 'proxy',
): Promise<Response> {
  const target = detectTarget(request, url);
  try {
    const userinfo = await fetchUserinfo(
      env.CACHE,
      infoType === 'proxy' ? env.PROXY_SUBS : env.RELAY_SUBS,
      force,
    );
    const subsHeaders: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (userinfo) subsHeaders['Subscription-Userinfo'] = userinfo;

    if (target === 'shadowrocket') {
      const config = await generateShadowrocket(env, selfBase, force);
      return new Response(config, {
        headers: { ...subsHeaders, 'Content-Disposition': 'attachment; filename="MySub.conf"' },
      });
    }
    if (target === 'surge') {
      const config = await generateSurge(env, selfBase, force);
      return new Response(config, {
        headers: { ...subsHeaders, 'Content-Disposition': 'attachment; filename="MySub.conf"' },
      });
    }
    const config = await generateClash(env, force);
    return new Response(config, {
      headers: { ...subsHeaders, 'Content-Disposition': 'attachment; filename="MySub.yaml"' },
    });
  } catch (e) {
    return new Response(`Error: ${String(e)}`, { status: 500 });
  }
}

// ─── /ruleset/:index ─────────────────────────────────────────────────────────

async function handleRulesetRequest(
  env: Env,
  index: number,
  url: URL,
  force: boolean,
): Promise<Response> {
  const t = url.searchParams.get('t') ?? 'shadowrocket';
  const target: ClientTarget = t === 'surge' ? 'surge' : 'shadowrocket';

  let ini: string;
  try {
    ini = await fetchFullIni(env, force);
  } catch (e) {
    return new Response(`Error fetching full.ini: ${String(e)}`, { status: 502 });
  }

  const rulesets = parseRuleSets(ini);
  const urlRules = urlRuleSets(rulesets);
  const allowedUrls = new Set(urlRules.map(r => r.target));

  if (index < 1 || index > urlRules.length) {
    return new Response('Ruleset index out of range', { status: 404 });
  }

  const ruleset = urlRules[index - 1];
  return handleRuleset(env, index, target, allowedUrls, ruleset.target, force);
}

// ─── Help text ────────────────────────────────────────────────────────────────

function helpText(base: string): string {
  return `mysub — Universal Proxy Subscription Converter
Source: full.ini in monlor/subconverter-rules

Endpoints:
  GET /sub?key=<KEY>                       Shadowrocket subscription (PROXY@/DIRECT@/RELAY@ prefixed)
  GET /config?key=<KEY>                    Auto-detect client by User-Agent and return config
  GET /config?key=<KEY>&target=<CLIENT>    Force client: shadowrocket | surge | clash
  GET /status?key=<KEY>                    Clients list + cache status (JSON)
  GET /ruleset/<N>?t=shadowrocket|surge    Converted ruleset (public, no key required)

  Add &force=1 to bypass cache and fetch fresh data on /config, /sub, and /ruleset.
  PROXY_SUBS/RELAY_SUBS refetch after SUB_CACHE_TTL seconds (default 3600); fetch failure keeps the last copy.
  Add &info=proxy (default) or &info=relay to control which subscription's traffic/expiry info is shown.

User-Agent auto-detection:
  Shadowrocket -> .conf (nodes from /sub, relay chain via RELAY@ groups)
  Surge        -> .conf (inline nodes with underlying-proxy chain)
  clash/mihomo -> .yaml (inline proxies with dialer-proxy chain)
  unknown      -> shadowrocket (default)

Config URL: ${base}/config?key=KEY
Sub URL (Shadowrocket only): ${base}/sub?key=KEY
Status: ${base}/status?key=KEY
`;
}
