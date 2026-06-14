import { Env, RuleSet, ProxyGroup, EXCLUDED_NODE_PATTERN } from './types.js';
import { parseRuleSets, parseProxyGroups, fetchFullIni } from './ini.js';

const LANDING_PROVIDER = 'landing';
const RELAY_PROVIDER = 'relay';
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

function relayIfacePolicy(iface: string) { return `🛜 网卡 ${iface}`; }
function quote(s: string) { return JSON.stringify(s); }

// ─── Proxy providers ─────────────────────────────────────────────────────────

function proxyProviderBlock(
  name: string,
  url: string,
  opts: { dialerProxy?: string; interfaceName?: string } = {},
): string[] {
  const lines = [
    `  ${name}:`,
    '    type: http',
    `    url: ${quote(url)}`,
    '    interval: 3600',
    '    health-check:',
    '      enable: true',
    '      lazy: true',
    `      url: ${quote(HEALTH_URL)}`,
    '      interval: 600',
  ];
  if (opts.dialerProxy || opts.interfaceName) {
    lines.push('    override:');
    if (opts.dialerProxy) lines.push(`      dialer-proxy: ${quote(opts.dialerProxy)}`);
    if (opts.interfaceName) lines.push(`      interface-name: ${quote(opts.interfaceName)}`);
  }
  return lines;
}

function generateProxyProviders(proxyUrl: string, relayUrl: string | null, iface: string | null): string {
  const lines = [
    '# External proxy providers',
    'proxy-providers:',
    ...proxyProviderBlock(LANDING_PROVIDER, proxyUrl, {
      dialerProxy: relayUrl ? RELAY_DIALER : undefined,
      interfaceName: relayUrl ? undefined : (iface ?? undefined),
    }),
  ];
  if (relayUrl) {
    lines.push(
      ...proxyProviderBlock(RELAY_PROVIDER, relayUrl, {
        interfaceName: iface ?? undefined,
      })
    );
  }
  return lines.join('\n');
}

// ─── Direct proxies (network interface binding) ──────────────────────────────

function generateDirectProxies(relayUrl: string | null): string {
  if (!relayUrl) return '';
  const lines = [
    '# Direct outbound proxies for selectable interface chaining',
    'proxies:',
  ];
  for (const iface of CLASH_IFACES) {
    lines.push(
      `  - name: ${quote(relayIfacePolicy(iface))}`,
      '    type: direct',
      '    udp: true',
      `    interface-name: ${quote(iface)}`,
    );
  }
  return lines.join('\n');
}

// ─── Proxy groups ────────────────────────────────────────────────────────────

function combinedFilter(filters: string[]): string | null {
  if (!filters.length) return null;
  if (filters.length === 1) return filters[0];
  return filters.map(f => `(?:${f})`).join('|');
}

function groupHeader(name: string, type: string): string[] {
  return [`- name: ${quote(name)}`, `  type: ${type}`];
}

function appendSeq(lines: string[], key: string, values: string[]): void {
  if (!values.length) return;
  lines.push(`  ${key}:`);
  for (const v of values) lines.push(`    - ${quote(v)}`);
}

function appendCommon(lines: string[], opts: {
  filters?: string[];
  hidden?: boolean;
  url?: string;
  interval?: string;
  tolerance?: string;
}): void {
  const f = combinedFilter(opts.filters ?? []);
  if (f) lines.push(`  filter: ${quote(f)}`);
  if (opts.url) lines.push(`  url: ${quote(opts.url)}`);
  if (opts.interval) lines.push(`  interval: ${opts.interval}`);
  if (opts.tolerance) lines.push(`  tolerance: ${opts.tolerance}`);
  if (opts.hidden) lines.push('  hidden: true');
}

function moveDirectToBottom(policies: string[]): string[] {
  if (!policies.length || policies[0] === DIRECT) return policies;
  const trailing = policies.filter(p => p === DIRECT);
  if (!trailing.length) return policies;
  return [...policies.filter(p => p !== DIRECT), ...trailing];
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

function generateProxyGroupLines(groups: ProxyGroup[], relayUrl: string | null): string[] {
  const all: string[][] = [];

  if (relayUrl) {
    const relaySelector = groupHeader(RELAY_DIALER, 'select');
    appendSeq(relaySelector, 'proxies', [
      '🇭🇰 香港中转', '🇸🇬 新加坡中转', '🇺🇲 美国中转', '🇯🇵 日本中转',
      RELAY_IFACE_POLICY, DIRECT,
    ]);
    all.push(relaySelector);

    const ifaceSelector = groupHeader(RELAY_IFACE_POLICY, 'select');
    appendSeq(ifaceSelector, 'proxies', CLASH_IFACES.map(relayIfacePolicy));
    all.push(ifaceSelector);
  }

  const landingGroup = groupHeader(LANDING_GROUP, 'select');
  appendSeq(landingGroup, 'use', [LANDING_PROVIDER]);
  appendCommon(landingGroup, { hidden: true });
  all.push(landingGroup);

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
        const providers = [LANDING_PROVIDER];
        if (relayUrl && FULL_NODE_SELECT.has(group.name)) providers.push(RELAY_PROVIDER);
        appendSeq(lines, 'use', providers);
      }
      appendCommon(lines, {
        filters: includeFiltered ? filters : [],
        hidden: shouldHide(group.name),
      });
      all.push(lines);
      continue;
    }

    if (['url-test', 'fallback', 'load-balance', 'random'].includes(group.groupType)) {
      const regex = group.items[0] ?? '';
      const [url, interval, tolerance] = parseTestOptions(group);
      const type = group.groupType === 'random' ? 'url-test' : group.groupType;
      const lines = groupHeader(group.name, type);
      appendSeq(lines, 'use', [LANDING_PROVIDER]);
      appendCommon(lines, {
        filters: regex ? [regex] : [],
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

  if (relayUrl) {
    const relayProvGroup = groupHeader(RELAY_GROUP_NAME, 'select');
    appendSeq(relayProvGroup, 'use', [RELAY_PROVIDER]);
    appendCommon(relayProvGroup, { hidden: true });
    all.push(relayProvGroup);

    const excl = `(?i)^(?!.*(${EXCL})).*`;
    for (const [name, kw] of [
      ['🇭🇰 香港中转', '香港|港|HK|Hong Kong'],
      ['🇸🇬 新加坡中转', '新加坡|坡|狮城|SG|Singapore'],
      ['🇺🇲 美国中转', '美国|US|United States|洛杉矶|西雅图|硅谷|圣何塞'],
      ['🇯🇵 日本中转', '日本|东京|大阪|泉日|埼玉|JP|Japan'],
    ] as [string, string][]) {
      const lines = groupHeader(name, 'url-test');
      appendSeq(lines, 'use', [RELAY_PROVIDER]);
      appendCommon(lines, {
        filters: [`${excl}(${kw}).*$`],
        hidden: true,
        url: HEALTH_URL,
        interval: '300',
      });
      all.push(lines);
    }
  }

  const result = ['# Generated from full.ini', 'proxy-groups:'];
  for (let i = 0; i < all.length; i++) {
    if (i > 0) result.push('');
    result.push(...all[i].map(l => '  ' + l));
  }
  return result;
}

function shouldHide(name: string): boolean {
  if (name === LANDING_GROUP || name === '🚀 默认节点') return false;
  return name.endsWith('节点') || name.endsWith('中转') || name === RELAY_GROUP_NAME;
}

// ─── Rule providers ──────────────────────────────────────────────────────────

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
      `  ${candidate}:`,
      '    type: http',
      `    url: ${quote(rs.target)}`,
      '    interval: 86400',
      '    behavior: classical',
      '    format: text',
    );
    idx++;
  }
  return [lines, names];
}

// ─── Rules ───────────────────────────────────────────────────────────────────

function generateRules(rulesets: RuleSet[], names: Map<RuleSet, string>): string[] {
  const lines = ['# Generated from full.ini', 'rules:'];
  for (const rs of rulesets) {
    let rule: string;
    if (rs.target.startsWith('[]')) {
      const inline = rs.target.slice(2);
      const parts = inline.split(',').map(p => p.trim()).filter(Boolean);
      if (parts[0].toUpperCase() === 'FINAL') {
        rule = `MATCH,${rs.policy}`;
      } else {
        rule = [...parts, rs.policy].join(',');
      }
    } else {
      rule = `RULE-SET,${names.get(rs)},${rs.policy}`;
    }
    lines.push(`  - ${quote(rule)}`);
  }
  return lines;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

export async function generateClash(env: Env, force = false): Promise<string> {
  const proxyUrl =
    env.PROXY_SUB_URL ??
    (env.PROXY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)[0] ??
    'https://example.invalid/PROXY_CLASH_URL';
  const relayRaw =
    env.RELAY_SUB_URL ??
    (env.RELAY_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)[0] ??
    null;
  const relayUrl = relayRaw || null;
  const iface = env.SURGE_INTERFACE ?? null;

  const ini = await fetchFullIni(env, force);
  const rulesets = parseRuleSets(ini);
  const groups = parseProxyGroups(ini);

  const [ruleProviderLines, providerNames] = generateRuleProviders(rulesets);
  const proxyGroupLines = generateProxyGroupLines(groups, relayUrl);
  const ruleLines = generateRules(rulesets, providerNames);

  const directProxies = generateDirectProxies(relayUrl);

  const sections = [
    '#!name=monlor mysub',
    '#!desc=Generated from full.ini for mihomo. Supports optional chained proxy providers through dialer-proxy.',
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
    generateProxyProviders(proxyUrl, relayUrl, iface),
    '',
    ...(directProxies ? [directProxies, ''] : []),
    ...proxyGroupLines,
    '',
    ...ruleProviderLines,
    '',
    ...ruleLines,
  ];

  return sections.join('\n').trimEnd() + '\n';
}
