import { Env, ProxyGroup } from './types.js';
import { fetchFullIni, fetchRepoFile, parseProxyGroups, parseRuleSets, rulesetSlug, loonRemoteRuleSets } from './ini.js';
import { fetchSubLines, parseSubCacheTtl } from './cache.js';
import { ParsedProxy, parseProxiesFromSubscription } from './proxy.js';

const TEST_URL = 'http://www.gstatic.com/generate_204';
const FULL_NODE_SELECT = new Set(['🚀 手动选择', '📶 VoWiFi']);
const TCP_TYPES = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'anytls']);
const RELAY_GROUP = '🔀 中转代理';
const RELAY_REGIONS: [string, string][] = [
  ['🇭🇰 香港中转', '香港|港|HK|Hong Kong'],
  ['🇸🇬 新加坡中转', '新加坡|坡|狮城|SG|Singapore'],
  ['🇺🇲 美国中转', '美国|US|United States|洛杉矶|西雅图|硅谷|圣何塞'],
  ['🇯🇵 日本中转', '日本|东京|大阪|泉日|埼玉|JP|Japan'],
];
const RELAY_INCLUDE = '(^|[^0-9.])1([.]0)?[x×](?![0-9a-z.])';
const RELAY_EXCLUDE = '家宽|住宅|HOME';
const quote = (value: string) => JSON.stringify(value);

export function toLoonLine(p: ParsedProxy): string | null {
  if (!TCP_TYPES.has(p.type) && p.type !== 'hy2') return null;
  const network = p.network || 'tcp';
  if (['vmess', 'vless', 'trojan'].includes(p.type) &&
      !(p.type === 'trojan' ? ['tcp', 'ws'] : ['tcp', 'ws', 'http']).includes(network)) return null;
  if (p.plugin && p.plugin !== 'obfs') return null;
  if (p.type === 'hy2' && p.obfs && p.obfs !== 'salamander') return null;

  const fields = [p.server, String(p.port)];
  let type: string = p.type;
  switch (p.type) {
    case 'ss':
      type = 'Shadowsocks';
      fields.push(p.cipher || 'aes-128-gcm', quote(p.password || ''));
      if (p.plugin === 'obfs') {
        fields.push(`obfs-name=${p.pluginMode || 'http'}`);
        // Loon keeps quotes in obfs-host as part of the hostname.
        if (p.pluginHost) {
          if (/[\s,"\\]/.test(p.pluginHost)) return null;
          fields.push(`obfs-host=${p.pluginHost}`);
        }
        if (p.pluginPath) fields.push(`obfs-uri=${quote(p.pluginPath)}`);
      }
      break;
    case 'ssr':
      if (p.obfs && !['plain', 'http_simple', 'http_post', 'tls1.2_ticket_auth'].includes(p.obfs)) return null;
      type = 'ShadowsocksR';
      fields.push(p.cipher || 'aes-256-cfb', quote(p.password || ''), `protocol=${p.protocol || 'origin'}`);
      if (p.protocolParam) fields.push(`protocol-param=${quote(p.protocolParam)}`);
      fields.push(`obfs=${p.obfs || 'plain'}`);
      if (p.obfsParam) fields.push(`obfs-param=${quote(p.obfsParam)}`);
      break;
    case 'vmess':
      type = 'VMess';
      fields.push(p.cipher || 'auto', quote(p.uuid || ''), `alterId=${p.alterId || 0}`);
      break;
    case 'vless':
      type = 'VLESS';
      fields.push(quote(p.uuid || ''));
      break;
    case 'trojan': type = 'Trojan'; fields.push(quote(p.password || '')); break;
    case 'hy2':
      type = 'Hysteria2';
      fields.push(quote(p.password || ''));
      if (p.obfsPassword) fields.push(`salamander-password=${quote(p.obfsPassword)}`);
      break;
    case 'anytls': type = 'AnyTLS'; fields.push(quote(p.password || '')); break;
  }
  if (['vmess', 'vless', 'trojan'].includes(p.type)) {
    fields.push(`transport=${network}`);
    if (network === 'ws' || network === 'http') {
      fields.push(`path=${quote(network === 'ws' ? p.wsPath || '/' : p.httpPath || '/')}`);
      const host = network === 'ws' ? p.wsHost : p.httpHost;
      if (host) fields.push(`host=${quote(host)}`);
    }
    if (p.type !== 'trojan') fields.push(`over-tls=${Boolean(p.tls)}`);
  }
  if (p.sni) fields.push(`sni=${quote(p.sni)}`);
  if (p.skipCertVerify) fields.push('skip-cert-verify=true');
  if (p.flow) fields.push(`flow=${p.flow}`);
  if (p.realityPbk) {
    fields.push(`public-key=${quote(p.realityPbk)}`);
    if (p.realitySid) fields.push(`short-id=${quote(p.realitySid)}`);
  }
  fields.push(`udp=${p.udp !== false}`);
  return `${p.name} = ${type},${fields.join(',')}`;
}

function matches(name: string, pattern: string): boolean {
  return new RegExp(pattern.replace(/^\(\?i\)/, ''), pattern.startsWith('(?i)') ? 'i' : '').test(name);
}

function groupLine(group: ProxyGroup, landing: string[], relay: string[]): string {
  if (group.groupType === 'select') {
    const policies = group.items.filter(i => i.startsWith('[]')).map(i => i.slice(2));
    const filters = group.items.filter(i => i && !i.startsWith('[]'));
    const include = filters.length && group.name !== '🚀 默认节点' &&
      (!policies.length || FULL_NODE_SELECT.has(group.name));
    const nodes = include ? [...landing, ...(FULL_NODE_SELECT.has(group.name) ? relay : [])]
      .filter(name => filters.some(pattern => matches(name, pattern))) : [];
    return `${group.name} = select,${[...new Set([...policies, ...nodes])].join(',') || 'DIRECT'}`;
  }
  const nodes = landing.filter(name => matches(name, group.items[0] || '.*'));
  // Keep empty regions valid without borrowing nodes from another region.
  if (!nodes.length) return `${group.name} = select,DIRECT`;
  const [interval = '300', , tolerance] = (group.items[2] || '').split(',');
  const type = group.groupType === 'random' ? 'load-balance' : group.groupType;
  const options = [`url=${group.items[1] || TEST_URL}`, `interval=${interval || '300'}`];
  if (type === 'url-test' && tolerance) options.push(`tolerance=${tolerance}`);
  if (group.groupType === 'random') options.push('algorithm=random');
  return `${group.name} = ${type},${[...nodes, ...options].join(',')}`;
}

function relayFilter(value: string | undefined, fallback: string, variable: string): RegExp | null {
  const pattern = value ?? fallback;
  if (!pattern) return null;
  try {
    return new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');
  } catch {
    throw new Error(`Invalid ${variable}: expected a regular expression`);
  }
}

function generateRules(ini: string, selfBase: string): [string, string] {
  const lines: string[] = [];
  const remote: string[] = [];
  const rulesets = parseRuleSets(ini);
  const indexes = new Map(loonRemoteRuleSets(rulesets).map((rs, i) => [rs, i + 1]));
  for (const rs of rulesets) {
    if (/^\[\]FINAL(?:,|$)/i.test(rs.target)) {
      lines.push(`FINAL,${rs.policy}`);
    } else {
      const slug = rs.target.startsWith('[]')
        ? rs.target.slice(2).toLowerCase().replace(/[^a-z0-9]+/g, '-') : rulesetSlug(rs.target);
      const id = `${indexes.get(rs)}-${slug}`;
      remote.push(`${selfBase}/ruleset/${id}?t=loon,policy=${rs.policy},tag=${rs.policy} - ${id},enabled=true`);
    }
  }
  return [lines.join('\n'), remote.join('\n')];
}

export async function generateLoon(env: Env, selfBase: string, force = false): Promise<string> {
  const include = relayFilter(env.LOON_RELAY_INCLUDE_REGEX, RELAY_INCLUDE, 'LOON_RELAY_INCLUDE_REGEX');
  const exclude = relayFilter(env.LOON_RELAY_EXCLUDE_REGEX, RELAY_EXCLUDE, 'LOON_RELAY_EXCLUDE_REGEX');
  const ttl = parseSubCacheTtl(env.SUB_CACHE_TTL);
  const [ini, template, landingLines, relayLines] = await Promise.all([
    fetchFullIni(env, force),
    fetchRepoFile(env, 'loon/template.conf', force),
    fetchSubLines(env.CACHE, env.PROXY_SUBS, force, ttl, 'PROXY_SUBS'),
    env.RELAY_SUBS.trim() ? fetchSubLines(env.CACHE, env.RELAY_SUBS, force, ttl, 'RELAY_SUBS') : [],
  ]);
  const supported = (lines: string[]) => parseProxiesFromSubscription(lines.join('\n')).filter(p => toLoonLine(p) !== null);
  const landing = supported(landingLines);
  const relay = supported(relayLines).filter(p => TCP_TYPES.has(p.type) &&
    (!include || include.test(p.name)) && (!exclude || !exclude.test(p.name)));
  const groups = parseProxyGroups(ini);
  const used = new Set(['DIRECT', 'REJECT', 'PROXY', RELAY_GROUP,
    ...RELAY_REGIONS.map(([name]) => name), ...groups.map(g => g.name)]);
  const unique = (name: string) => {
    // Node names are unquoted policy references in Loon's comma-delimited format.
    const base = name.replace(/[,=\r\n"`]/g, '_') || 'Node';
    let next = base, suffix = 2;
    while (used.has(next)) next = `${base} (${suffix++})`;
    used.add(next);
    return next;
  };
  const proxies: string[] = [];
  const chainLines: string[] = [];
  const relays = relay.map(p => ({ ...p, name: unique(p.name) }));
  proxies.push(...relays.map(p => toLoonLine(p)!));
  const landingNames = landing.map(p => {
    const name = unique(p.name);
    if (!relays.length || !TCP_TYPES.has(p.type)) {
      proxies.push(toLoonLine({ ...p, name })!);
      return name;
    }
    const nodeName = unique(`LANDING@${name}`);
    proxies.push(toLoonLine({ ...p, name: nodeName })!);
    // Raw landing nodes are chain internals; public groups use the chain names.
    chainLines.push(`${name} = ${RELAY_GROUP},${nodeName},udp=false`);
    return name;
  });
  const relayNames = relays.map(r => r.name);
  const regions = RELAY_REGIONS.map(([name, pattern]) => ({
    name, nodes: relays.filter(r => matches(r.name, pattern)).map(r => r.name),
  })).filter(region => region.nodes.length);
  const relayChoices = regions.map(region => region.name);
  // Keep subscriptions with no recognized region reachable, without dangling groups.
  if (!relayChoices.length) relayChoices.push(...relayNames);
  const groupLines = [
    `${RELAY_GROUP} = select,${[...relayChoices, 'DIRECT'].join(',')}`,
    ...(env.RELAY_SUBS.trim() && !relays.length ? ['# No eligible relay nodes; only direct-to-landing nodes are available.'] : []),
    ...groups.map(g => groupLine(g, landingNames, relayNames)),
    ...regions.map(region => `${region.name} = url-test,${region.nodes.join(',')},url=${TEST_URL},interval=300,tolerance=50`),
  ];
  const [rules, remoteRules] = generateRules(ini, selfBase);
  let result = template;
  for (const [placeholder, value] of Object.entries({
    '{{PROXY_SECTION}}': proxies.join('\n'),
    '{{PROXY_GROUP_SECTION}}': groupLines.join('\n'),
    '{{PROXY_CHAIN_SECTION}}': chainLines.join('\n'),
    '{{RULE_SECTION}}': rules,
    '{{REMOTE_RULE_SECTION}}': remoteRules,
  })) {
    if (!result.includes(placeholder)) throw new Error(`Missing template placeholder: ${placeholder}`);
    result = result.replace(placeholder, () => value);
  }
  return result.trimEnd() + '\n';
}
