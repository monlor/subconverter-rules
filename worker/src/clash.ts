import { Env, RuleSet, ProxyGroup, EXCLUDED_NODE_PATTERN } from './types.js';
import { parseRuleSets, parseProxyGroups, fetchFullIni } from './ini.js';
import { fetchSubLines } from './cache.js';
import { parseProxiesFromSubscription, toClashProxyYaml, ParsedProxy } from './proxy.js';

const LANDING_GROUP = '代理节点';
const RELAY_GROUP_NAME = '中转节点';
const RELAY_DIALER = '🔀 中转代理';
const RELAY_IFACE_POLICY = '↔️ 中转网卡';
const DIRECT = 'DIRECT';
const HEALTH_URL = 'http://www.gstatic.com/generate_204';
const EXCL = EXCLUDED_NODE_PATTERN;
const FULL_NODE_SELECT = new Set(['🚀 手动选择', '📶 VoWiFi']);

const CLASH_IFACES = [
  ...Array.from({ length: 11 }, (_, i) => `en${i}`),
  'bridge0', 'pdp_ip0', 'eth0', 'eth1', 'wlan0', 'wlan1',
  'enp0s3', 'enp1s0', 'enp2s0', 'ens3', 'ens18', 'ens33',
  'wlp2s0', 'wlp3s0', 'usb0', 'rmnet_data0', 'rmnet_data1',
  'ccmni0', 'ccmni1', 'Ethernet', 'Ethernet 2', 'Wi-Fi', 'WLAN', '以太网', '以太网 2',
];

const REGION_PATTERNS: [string, string][] = [
  ['🇭🇰 香港中转', '香港|港|HK|Hong Kong'],
  ['🇸🇬 新加坡中转', '新加坡|坡|狮城|SG|Singapore'],
  ['🇺🇲 美国中转', '美国|US|United States|洛杉矶|西雅图|硅谷|圣何塞'],
  ['🇯🇵 日本中转', '日本|东京|大阪|泉日|埼玉|JP|Japan'],
];

function toJsRegex(pattern: string): RegExp {
  return new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');
}

function relayIfacePolicy(iface: string) { return `🛜 网卡 ${iface}`; }
function quote(s: string) { return JSON.stringify(s); }

function matchesExclude(name: string): boolean {
  return EXCL.split('|').some(e => name.includes(e));
}
function matchesRegion(name: string, pattern: string): boolean {
  return pattern.split('|').some(k => name.includes(k));
}

// ─── proxies: section ────────────────────────────────────────────────────────

function generateProxiesSection(
  landingProxies: ParsedProxy[],
  relayProxies: ParsedProxy[],
  hasRelay: boolean,
): string {
  const dialerProxy = hasRelay ? RELAY_DIALER : undefined;
  const lines: string[] = ['# Inline proxies converted from subscription URIs', 'proxies:'];

  // Interface-bound direct proxies for relay interface selector
  if (hasRelay) {
    for (const iface of CLASH_IFACES) {
      lines.push(
        `  - name: ${quote(relayIfacePolicy(iface))}`,
        '    type: direct',
        '    udp: true',
        `    interface-name: ${quote(iface)}`,
      );
    }
  }

  for (const p of landingProxies) {
    const yaml = toClashProxyYaml(p, dialerProxy);
    if (yaml) lines.push(yaml);
  }
  if (hasRelay) {
    for (const p of relayProxies) {
      const yaml = toClashProxyYaml(p);
      if (yaml) lines.push(yaml);
    }
  }
  return lines.join('\n');
}

// ─── proxy-groups: section ───────────────────────────────────────────────────

function groupHeader(name: string, type: string): string[] {
  return [`- name: ${quote(name)}`, `  type: ${type}`];
}
function appendSeq(lines: string[], key: string, values: string[]): void {
  if (!values.length) return;
  lines.push(`  ${key}:`);
  for (const v of values) lines.push(`    - ${quote(v)}`);
}
function appendCommon(lines: string[], opts: {
  filter?: string; hidden?: boolean; url?: string; interval?: string; tolerance?: string;
}): void {
  if (opts.filter) lines.push(`  filter: ${quote(opts.filter)}`);
  if (opts.url) lines.push(`  url: ${quote(opts.url)}`);
  if (opts.interval) lines.push(`  interval: ${opts.interval}`);
  if (opts.tolerance) lines.push(`  tolerance: ${opts.tolerance}`);
  if (opts.hidden) lines.push('  hidden: true');
}

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
  const url = group.items[1] ?? HEALTH_URL;
  let interval = '300', tolerance = '';
  if (group.items[2]) {
    const tp = group.items[2].split(',').map(p => p.trim());
    if (tp[0]) interval = tp[0];
    if (tp[2]) tolerance = tp[2];
  }
  return [url, interval, tolerance];
}
function shouldHide(name: string): boolean {
  if (name === LANDING_GROUP || name === '🚀 默认节点') return false;
  return name.endsWith('节点') || name.endsWith('中转') || name === RELAY_GROUP_NAME;
}
function combinedFilter(filters: string[]): string | null {
  if (!filters.length) return null;
  if (filters.length === 1) return filters[0];
  return filters.map(f => `(?:${f})`).join('|');
}

function generateProxyGroupLines(
  groups: ProxyGroup[],
  landingNames: string[],
  relayProxies: ParsedProxy[],
  hasRelay: boolean,
): string {
  const all: string[][] = [];

  if (hasRelay) {
    // 🔀 中转代理
    const relaySelector = groupHeader(RELAY_DIALER, 'select');
    appendSeq(relaySelector, 'proxies', [
      ...REGION_PATTERNS.map(([name]) => name).filter(name =>
        relayProxies.some(p => !matchesExclude(p.name) && matchesRegion(p.name, name.replace(/ .*$/, '').slice(2)))
      ),
      RELAY_IFACE_POLICY,
      DIRECT,
    ]);
    all.push(relaySelector);

    // ↔️ 中转网卡
    const ifaceSelector = groupHeader(RELAY_IFACE_POLICY, 'select');
    appendSeq(ifaceSelector, 'proxies', CLASH_IFACES.map(relayIfacePolicy));
    all.push(ifaceSelector);
  }

  // 代理节点
  const landingGroup = groupHeader(LANDING_GROUP, 'select');
  appendSeq(landingGroup, 'proxies', landingNames);
  appendCommon(landingGroup, { hidden: true });
  all.push(landingGroup);

  // Groups from full.ini
  for (const group of groups) {
    let [policies, filters] = parsedItems(group);
    policies = moveDirectToBottom(policies);

    if (group.groupType === 'select') {
      const lines = groupHeader(group.name, 'select');
      appendSeq(lines, 'proxies', policies);
      const includeFiltered =
        filters.length > 0 &&
        group.name !== '🚀 默认节点' &&
        (!policies.length || FULL_NODE_SELECT.has(group.name));
      if (includeFiltered) {
        const filter = combinedFilter(filters);
        appendSeq(lines, 'use', [LANDING_GROUP]);
        appendCommon(lines, { filter: filter ?? undefined, hidden: shouldHide(group.name) });
      } else {
        appendCommon(lines, { hidden: shouldHide(group.name) });
      }
      all.push(lines);
      continue;
    }

    if (['url-test', 'fallback', 'load-balance', 'random'].includes(group.groupType)) {
      const regex = group.items[0] ?? '';
      const [url, interval, tolerance] = parseTestOptions(group);
      const type = group.groupType === 'random' ? 'url-test' : group.groupType;
      const lines = groupHeader(group.name, type);
      // Use inline proxy names matching the filter
      const filtered = regex
        ? landingNames.filter(name => toJsRegex(regex).test(name))
        : landingNames;
      if (filtered.length) {
        appendSeq(lines, 'proxies', filtered);
      } else {
        appendSeq(lines, 'proxies', landingNames);
      }
      appendCommon(lines, {
        hidden: shouldHide(group.name),
        url,
        interval,
        tolerance: tolerance || undefined,
      });
      all.push(lines);
      continue;
    }

    const lines = groupHeader(group.name, group.groupType);
    appendSeq(lines, 'proxies', policies);
    appendCommon(lines, { hidden: shouldHide(group.name) });
    all.push(lines);
  }

  // Relay groups with explicit filtered lists
  if (hasRelay && relayProxies.length) {
    const relayGroup = groupHeader(RELAY_GROUP_NAME, 'select');
    appendSeq(relayGroup, 'proxies', relayProxies.map(p => p.name));
    appendCommon(relayGroup, { hidden: true });
    all.push(relayGroup);

    for (const [groupName, pattern] of REGION_PATTERNS) {
      const filtered = relayProxies
        .filter(p => !matchesExclude(p.name) && matchesRegion(p.name, pattern))
        .map(p => p.name);
      if (!filtered.length) continue;
      const lines = groupHeader(groupName, 'url-test');
      appendSeq(lines, 'proxies', filtered);
      appendCommon(lines, { hidden: true, url: HEALTH_URL, interval: '300' });
      all.push(lines);
    }
  }

  const result = ['# Generated from full.ini', 'proxy-groups:'];
  for (let i = 0; i < all.length; i++) {
    if (i > 0) result.push('');
    result.push(...all[i].map(l => '  ' + l));
  }
  return result.join('\n');
}

// ─── rule-providers + rules ──────────────────────────────────────────────────

function generateRuleProviders(rulesets: RuleSet[]): [string[], Map<RuleSet, string>] {
  const lines = ['# Generated from full.ini ruleset URLs', 'rule-providers:'];
  const names = new Map<RuleSet, string>();
  const used = new Set<string>();
  let idx = 1;
  for (const rs of rulesets) {
    if (rs.target.startsWith('[]')) continue;
    const stem = rs.target.split('/').pop()?.replace(/\.[^.]+$/, '') ?? `rs${idx}`;
    const cleaned = stem.replace(/[^0-9A-Za-z_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    let name = cleaned ? `ruleset_${cleaned}` : `ruleset_${String(idx).padStart(2, '0')}`;
    let candidate = name, suffix = 2;
    while (used.has(candidate)) { candidate = `${name}_${suffix++}`; }
    used.add(candidate);
    names.set(rs, candidate);
    lines.push(
      `  ${candidate}:`, '    type: http', `    url: ${quote(rs.target)}`,
      '    interval: 86400', '    behavior: classical', '    format: text',
    );
    idx++;
  }
  return [lines, names];
}

function generateRules(rulesets: RuleSet[], names: Map<RuleSet, string>): string[] {
  const lines = ['# Generated from full.ini', 'rules:'];
  for (const rs of rulesets) {
    let rule: string;
    if (rs.target.startsWith('[]')) {
      const parts = rs.target.slice(2).split(',').map(p => p.trim()).filter(Boolean);
      rule = parts[0].toUpperCase() === 'FINAL' ? `MATCH,${rs.policy}` : [...parts, rs.policy].join(',');
    } else {
      rule = `RULE-SET,${names.get(rs)},${rs.policy}`;
    }
    lines.push(`  - ${quote(rule)}`);
  }
  return lines;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

export async function generateClash(env: Env, force = false): Promise<string> {
  const hasRelaySubs = Boolean((env.RELAY_SUBS ?? '').trim());

  const [ini, landingLines, relayLines] = await Promise.all([
    fetchFullIni(env, force),
    fetchSubLines(env.CACHE, env.PROXY_SUBS ?? '', force),
    hasRelaySubs ? fetchSubLines(env.CACHE, env.RELAY_SUBS ?? '', force) : Promise.resolve([] as string[]),
  ]);

  const landingProxies = parseProxiesFromSubscription(landingLines.join('\n'));
  const relayProxies = parseProxiesFromSubscription(relayLines.join('\n'));
  const hasRelay = relayProxies.length > 0;

  const rulesets = parseRuleSets(ini);
  const groups = parseProxyGroups(ini);
  const landingNames = landingProxies.map(p => p.name);

  const [ruleProviderLines, providerNames] = generateRuleProviders(rulesets);
  const proxiesSection = generateProxiesSection(landingProxies, relayProxies, hasRelay);
  const proxyGroupLines = generateProxyGroupLines(groups, landingNames, relayProxies, hasRelay);
  const ruleLines = generateRules(rulesets, providerNames);

  const sections = [
    '#!name=monlor mysub',
    '#!desc=Generated from full.ini for mihomo. Inline proxies with optional dialer-proxy chain.',
    '',
    'mixed-port: 7890',
    'allow-lan: true',
    'mode: rule',
    'log-level: info',
    'ipv6: true',
    'unified-delay: true',
    'tcp-concurrent: true',
    'profile:',
    '  store-selected: true',
    '  store-fake-ip: true',
    '',
    proxiesSection,
    '',
    proxyGroupLines,
    '',
    ...ruleProviderLines,
    '',
    ...ruleLines,
  ];

  return sections.join('\n').trimEnd() + '\n';
}
