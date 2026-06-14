import { Env, RuleSet, ProxyGroup, EXCLUDED_NODE_PATTERN } from './types.js';
import { fetchRepoFile, parseRuleSets, parseProxyGroups, fetchFullIni } from './ini.js';

const FULL_NODE_SELECT = new Set(['🚀 手动选择', '📶 VoWiFi']);
const LANDING_PROVIDER = '代理节点';
const RELAY_PROVIDER = '中转节点';
const DEFAULT_INTERFACE = '🌐 默认网卡';
const CELLULAR_POLICY = '📱 蜂窝流量';
const RELAY_INTERFACE_POLICY = '↔️ 中转网卡';
const DIRECT = 'DIRECT';
const RELAY_DIALER = '🔀 中转代理';
const EXCL = EXCLUDED_NODE_PATTERN;

const MAC_INTERFACE_NOTES = [
  '# Common macOS interfaces:',
  '# en0: usually Wi-Fi or the primary default interface',
  '# en1/en2/en3: often Thunderbolt bridge or additional built-in/virtual Ethernet interfaces',
  '# en4/en5/en6/en7/en8/en9/en10: often USB-C Ethernet, USB tethering, or extra adapters',
  '# utun0/utun1/...: VPN/tunnel interfaces, usable only when you intentionally bind a tunnel',
  '# pdp_ip0: cellular data interface on iOS and some tethering environments',
];

const RELAY_IFACES = [
  ...Array.from({ length: 11 }, (_, i) => `en${i}`),
  ...Array.from({ length: 6 }, (_, i) => `utun${i}`),
  'pdp_ip0',
];

function relayIfacePolicy(iface: string) {
  return `🛜 网卡 ${iface}`;
}

function ifaceModifier(iface: string) {
  return `interface=${iface},allow-other-interface=false,dns-follow-interface=true`;
}

function extPolicyModifier(underlying: string | null, iface: string | null): string | null {
  const parts: string[] = [];
  if (underlying) parts.push(`underlying-proxy=${underlying}`);
  if (iface) parts.push(ifaceModifier(iface));
  if (!parts.length) return null;
  return `external-policy-modifier="${parts.join(',')}"`;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ─── [Proxy] section ─────────────────────────────────────────────────────────

function generateProxySection(iface: string | null): string {
  const lines = [...MAC_INTERFACE_NOTES];
  if (iface) {
    lines.push(`${DEFAULT_INTERFACE} = direct,${ifaceModifier(iface)}`);
  }
  for (const ri of RELAY_IFACES) {
    lines.push(`${relayIfacePolicy(ri)} = direct,${ifaceModifier(ri)}`);
  }
  return lines.join('\n');
}

// ─── [Proxy Group] section ───────────────────────────────────────────────────

function parsedItems(group: ProxyGroup): [string[], string[]] {
  const policies: string[] = [];
  const filters: string[] = [];
  for (const item of group.items) {
    if (!item) continue;
    if (item.startsWith('[]')) policies.push(item.slice(2));
    else filters.push(item);
  }
  return [policies, filters];
}

function moveDirectToBottom(policies: string[]): string[] {
  if (!policies.length || policies[0] === DIRECT) return policies;
  const trailing = policies.filter(p => p === DIRECT);
  if (!trailing.length) return policies;
  return [...policies.filter(p => p !== DIRECT), ...trailing];
}

function parseTestOptions(group: ProxyGroup): [string, string, string] {
  const url = group.items[1] ?? 'http://www.gstatic.com/generate_204';
  let interval = '300', tolerance = '';
  if (group.items[2]) {
    const tp = group.items[2].split(',').map(p => p.trim());
    if (tp[0]) interval = tp[0];
    if (tp[2]) tolerance = tp[2];
  }
  return [url, interval, tolerance];
}

function convertSelectGroup(group: ProxyGroup, relayUrl: string | null): string {
  let [policies, filters] = parsedItems(group);
  policies = moveDirectToBottom(policies);
  const fields = [group.groupType, ...policies];
  const includeFiltered =
    filters.length > 0 &&
    group.name !== '🚀 默认节点' &&
    (!policies.length || FULL_NODE_SELECT.has(group.name));

  if (includeFiltered) {
    const providers = [LANDING_PROVIDER];
    if (relayUrl && FULL_NODE_SELECT.has(group.name)) providers.push(RELAY_PROVIDER);
    if (providers.length === 1) {
      fields.push(`include-other-group=${providers[0]}`);
    } else {
      fields.push(`include-other-group=${quote(providers.join(','))}`);
    }
    for (const f of filters) fields.push(`policy-regex-filter=${quote(f)}`);
  }
  return `${group.name} = ${fields.join(',')}`;
}

function convertExternalGroup(group: ProxyGroup): string {
  const regex = group.items[0] ?? '';
  const [url, interval, tolerance] = parseTestOptions(group);
  const isUrlTest = group.groupType === 'url-test';
  const fields = [
    isUrlTest ? 'smart' : group.groupType,
    `include-other-group=${LANDING_PROVIDER}`,
  ];
  if (!isUrlTest) {
    fields.push(`url=${url}`, `interval=${interval}`);
    if (tolerance) fields.push(`tolerance=${tolerance}`);
  }
  if (regex) fields.push(`policy-regex-filter=${quote(regex)}`);
  return `${group.name} = ${fields.join(',')}`;
}

function convertGroup(group: ProxyGroup, relayUrl: string | null): string {
  if (group.groupType === 'select') return convertSelectGroup(group, relayUrl);
  if (['url-test', 'fallback', 'load-balance', 'random'].includes(group.groupType)) {
    return convertExternalGroup(group);
  }
  const fields = [group.groupType];
  for (const item of group.items) {
    if (item.startsWith('[]')) fields.push(item.slice(2));
    else if (item) fields.push(item);
  }
  return `${group.name} = ${fields.join(',')}`;
}

function generateRelayChoices(relayUrl: string | null): string[] {
  const choices: string[] = [];
  if (relayUrl) choices.push('🇭🇰 香港中转', '🇸🇬 新加坡中转', '🇺🇲 美国中转', '🇯🇵 日本中转');
  choices.push(CELLULAR_POLICY, RELAY_INTERFACE_POLICY, DIRECT);
  return choices;
}

function generateProviderGroups(
  proxyUrl: string,
  relayUrl: string | null,
  iface: string | null,
): string {
  const proxyModifier = extPolicyModifier(RELAY_DIALER, iface);
  const proxyFields = [
    `${LANDING_PROVIDER} = select`,
    `policy-path=${proxyUrl}`,
    'hidden=true',
  ];
  if (proxyModifier) proxyFields.push(proxyModifier);

  const lines = [
    '# External policies',
    `${RELAY_DIALER} = select,${generateRelayChoices(relayUrl).join(',')}`,
    `${CELLULAR_POLICY} = select,CELLULAR-ONLY,hidden=true`,
    `${RELAY_INTERFACE_POLICY} = select,${RELAY_IFACES.map(relayIfacePolicy).join(',')}`,
    proxyFields.join(','),
  ];
  return lines.join('\n');
}

function generateRelayGroups(relayUrl: string, iface: string | null): string {
  const excl = `(?i)^(?!.*(${EXCL})).*`;
  const relayFields = [`${RELAY_PROVIDER} = select`, `policy-path=${relayUrl}`, 'hidden=true'];
  const relayModifier = extPolicyModifier(null, iface);
  if (relayModifier) relayFields.push(relayModifier);

  const regions = [
    ['🇭🇰 香港中转', '香港|港|HK|Hong Kong'],
    ['🇸🇬 新加坡中转', '新加坡|坡|狮城|SG|Singapore'],
    ['🇺🇲 美国中转', '美国|US|United States|洛杉矶|西雅图|硅谷|圣何塞'],
    ['🇯🇵 日本中转', '日本|东京|大阪|泉日|埼玉|JP|Japan'],
  ];

  const regionLines = regions.map(([name, kw]) =>
    `${name} = smart,include-other-group=${RELAY_PROVIDER},hidden=true,policy-regex-filter="${excl}(${kw}).*$"`
  );

  return [relayFields.join(','), ...regionLines].join('\n');
}

function generateProxyGroupSection(
  groups: ProxyGroup[],
  proxyUrl: string,
  relayUrl: string | null,
  iface: string | null,
): string {
  const lines = [
    '# Generated from full.ini',
    generateProviderGroups(proxyUrl, relayUrl, iface),
    ...groups.map(g => convertGroup(g, relayUrl)),
  ];
  if (relayUrl) {
    lines.push('# Relay subscription groups');
    lines.push(generateRelayGroups(relayUrl, iface));
  }
  return lines.join('\n');
}

// ─── [Rule] section ──────────────────────────────────────────────────────────

function convertRulesetLine(rs: RuleSet, urlIndex: number, selfBase: string): string {
  const { policy, target, options } = rs;
  if (target.startsWith('[]')) {
    const inline = target.slice(2);
    const parts = inline.split(',').map(p => p.trim()).filter(Boolean);
    const ruleType = parts[0].toUpperCase() === 'DST-PORT' ? 'DEST-PORT' : parts[0].toUpperCase();
    if (ruleType === 'FINAL') return `FINAL,${policy}`;
    return [ruleType, ...parts.slice(1), policy].join(',');
  }
  const opts = options.filter(Boolean);
  return ['RULE-SET', `${selfBase}/ruleset/${urlIndex}?t=surge`, policy, ...opts].join(',');
}

function generateRuleSection(rulesets: RuleSet[], selfBase: string): string {
  let urlIdx = 1;
  const lines: string[] = ['# Generated from full.ini'];
  for (const rs of rulesets) {
    if (rs.target.startsWith('[]')) {
      lines.push(convertRulesetLine(rs, 0, selfBase));
    } else {
      lines.push(convertRulesetLine(rs, urlIdx++, selfBase));
    }
  }
  return lines.join('\n');
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

export async function generateSurge(env: Env, selfBase: string, force = false): Promise<string> {
  const proxyUrl =
    env.PROXY_SUB_URL ??
    (env.PROXY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)[0] ??
    'https://example.invalid/PROXY_SURGE_URL';
  const relayRaw =
    env.RELAY_SUB_URL ??
    (env.RELAY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)[0] ??
    null;
  const relayUrl = relayRaw || null;
  const iface = env.SURGE_INTERFACE ?? null;

  const [ini, template] = await Promise.all([
    fetchFullIni(env, force),
    fetchRepoFile(env, 'surge/template.conf', force),
  ]);

  const rulesets = parseRuleSets(ini);
  const groups = parseProxyGroups(ini);

  const proxySection = generateProxySection(iface);
  const proxyGroupSection = generateProxyGroupSection(groups, proxyUrl, relayUrl, iface);
  const ruleSection = generateRuleSection(rulesets, selfBase);

  const placeholders: Record<string, string> = {
    '{{PROXY_SECTION}}': proxySection,
    '{{PROXY_GROUP_SECTION}}': proxyGroupSection,
    '{{RULE_SECTION}}': ruleSection,
  };

  let result = template;
  for (const [ph, value] of Object.entries(placeholders)) {
    if (!result.includes(ph)) throw new Error(`Missing template placeholder: ${ph}`);
    result = result.replace(ph, value);
  }

  return result.trimEnd() + '\n';
}
