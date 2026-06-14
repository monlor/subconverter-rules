import { Env, RuleSet, ProxyGroup, EXCLUDED_NODE_PATTERN } from './types.js';
import { fetchRepoFile, parseRuleSets, parseProxyGroups, fetchFullIni } from './ini.js';
import { fetchSubLines } from './cache.js';
import { parseProxiesFromSubscription, toSurgeLine, ParsedProxy } from './proxy.js';

const FULL_NODE_SELECT = new Set(['🚀 手动选择', '📶 VoWiFi']);
const LANDING_GROUP = '代理节点';
const RELAY_GROUP_NAME = '中转节点';
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

function relayIfacePolicy(iface: string) { return `🛜 网卡 ${iface}`; }
function ifaceModifier(iface: string) {
  return `interface=${iface},allow-other-interface=false,dns-follow-interface=true`;
}
function quote(s: string) { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

// ─── Fetch & parse subs ──────────────────────────────────────────────────────
// ─── Region filter ───────────────────────────────────────────────────────────

const REGION_PATTERNS: [string, string, string][] = [
  ['🇭🇰 香港中转', '香港|港|HK|Hong Kong', 'HK'],
  ['🇸🇬 新加坡中转', '新加坡|坡|狮城|SG|Singapore', 'SG'],
  ['🇺🇲 美国中转', '美国|US|United States|洛杉矶|西雅图|硅谷|圣何塞', 'US'],
  ['🇯🇵 日本中转', '日本|东京|大阪|泉日|埼玉|JP|Japan', 'JP'],
];

function matchesExclude(name: string): boolean {
  const excl = EXCL.split('|');
  return excl.some(e => name.includes(e));
}
function matchesRegion(name: string, pattern: string): boolean {
  return pattern.split('|').some(k => name.includes(k));
}

// ─── [Proxy] section ─────────────────────────────────────────────────────────

function generateProxySection(
  landingProxies: ParsedProxy[],
  relayProxies: ParsedProxy[],
  hasRelay: boolean,
): string {
  const lines = [...MAC_INTERFACE_NOTES];
  for (const ri of RELAY_IFACES) {
    lines.push(`${relayIfacePolicy(ri)} = direct,${ifaceModifier(ri)}`);
  }
  lines.push('');

  const underlying = hasRelay ? RELAY_DIALER : undefined;
  for (const p of landingProxies) {
    const line = toSurgeLine(p, underlying);
    if (line) lines.push(line);
  }
  if (hasRelay && relayProxies.length) {
    lines.push('');
    for (const p of relayProxies) {
      const line = toSurgeLine(p);
      if (line) lines.push(line);
    }
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

function convertSelectGroup(
  group: ProxyGroup,
  hasRelay: boolean,
): string {
  let [policies, filters] = parsedItems(group);
  policies = moveDirectToBottom(policies);
  const fields = [group.groupType, ...policies];
  const includeFiltered =
    filters.length > 0 &&
    group.name !== '🚀 默认节点' &&
    (!policies.length || FULL_NODE_SELECT.has(group.name));

  if (includeFiltered) {
    const groups = [LANDING_GROUP];
    if (hasRelay && FULL_NODE_SELECT.has(group.name)) groups.push(RELAY_GROUP_NAME);
    fields.push(
      groups.length === 1
        ? `include-other-group=${groups[0]}`
        : `include-other-group=${quote(groups.join(','))}`,
    );
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
    `include-other-group=${LANDING_GROUP}`,
  ];
  if (!isUrlTest) {
    fields.push(`url=${url}`, `interval=${interval}`);
    if (tolerance) fields.push(`tolerance=${tolerance}`);
  }
  if (regex) fields.push(`policy-regex-filter=${quote(regex)}`);
  return `${group.name} = ${fields.join(',')}`;
}

function convertGroup(
  group: ProxyGroup,
  hasRelay: boolean,
): string {
  if (group.groupType === 'select') return convertSelectGroup(group, hasRelay);
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

function generateRelayChoices(hasRelay: boolean): string[] {
  const choices: string[] = [];
  if (hasRelay) choices.push(...REGION_PATTERNS.map(([name]) => name));
  choices.push(CELLULAR_POLICY, RELAY_INTERFACE_POLICY, DIRECT);
  return choices;
}

function generateProxyGroupSection(
  groups: ProxyGroup[],
  landingNames: string[],
  relayProxies: ParsedProxy[],
  hasRelay: boolean,
): string {
  const lines = ['# Generated from full.ini + subscription nodes'];

  // Chain selector + cell + interface + provider groups
  lines.push(`${RELAY_DIALER} = select,${generateRelayChoices(hasRelay).join(',')}`);
  lines.push(`${CELLULAR_POLICY} = select,CELLULAR-ONLY,hidden=true`);
  lines.push(`${RELAY_INTERFACE_POLICY} = select,${RELAY_IFACES.map(relayIfacePolicy).join(',')}`);

  // 代理节点 = all landing node names
  lines.push(`${LANDING_GROUP} = select,${landingNames.join(',')},hidden=true`);

  // Groups from full.ini
  for (const group of groups) {
    lines.push(convertGroup(group, hasRelay));
  }

  // Relay region groups with explicit relay node names
  if (hasRelay && relayProxies.length) {
    const relayNames = relayProxies.map(p => p.name);
    lines.push(`${RELAY_GROUP_NAME} = select,${relayNames.join(',')},hidden=true`);

    for (const [groupName, pattern] of REGION_PATTERNS) {
      const filtered = relayProxies
        .filter(p => !matchesExclude(p.name) && matchesRegion(p.name, pattern))
        .map(p => p.name);
      if (!filtered.length) continue;
      lines.push(`${groupName} = smart,${filtered.join(',')},hidden=true`);
    }
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
    lines.push(rs.target.startsWith('[]')
      ? convertRulesetLine(rs, 0, selfBase)
      : convertRulesetLine(rs, urlIdx++, selfBase));
  }
  return lines.join('\n');
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

export async function generateSurge(env: Env, selfBase: string, force = false): Promise<string> {
  const hasRelaySubs = Boolean((env.RELAY_SUBS ?? '').trim());

  const [ini, template, landingLines, relayLines] = await Promise.all([
    fetchFullIni(env, force),
    fetchRepoFile(env, 'surge/template.conf', force),
    fetchSubLines(env.CACHE, env.PROXY_SUBS ?? '', force),
    hasRelaySubs ? fetchSubLines(env.CACHE, env.RELAY_SUBS ?? '', force) : Promise.resolve([] as string[]),
  ]);

  const landingProxies = parseProxiesFromSubscription(landingLines.join('\n'));
  const relayProxies = parseProxiesFromSubscription(relayLines.join('\n'));
  const hasRelay = relayProxies.length > 0;

  const rulesets = parseRuleSets(ini);
  const groups = parseProxyGroups(ini);
  const landingNames = landingProxies.map(p => p.name).filter(n => n);

  const proxySection = generateProxySection(landingProxies, relayProxies, hasRelay);
  const proxyGroupSection = generateProxyGroupSection(groups, landingNames, relayProxies, hasRelay);
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
