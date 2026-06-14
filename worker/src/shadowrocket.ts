import { Env, RuleSet, ProxyGroup, EXCLUDED_NODE_PATTERN } from './types.js';
import { fetchRepoFile, parseRuleSets, parseProxyGroups, fetchFullIni } from './ini.js';

const FULL_NODE_SELECT = new Set(['🚀 手动选择', '📶 VoWiFi']);
const RELAY_GROUP = '🔀 中转代理';
const RELAY_FILTER = `(?i)^RELAY@(?!.*(${EXCLUDED_NODE_PATTERN})).*`;

// ─── Proxy group conversion ──────────────────────────────────────────────────

function groupItem(item: string): string | null {
  if (!item) return null;
  return item.startsWith('[]') ? item.slice(2) : item;
}

function convertProxyGroup(group: ProxyGroup): string {
  if (group.groupType === 'select') {
    const policies: string[] = [];
    const filters: string[] = [];
    for (const item of group.items) {
      const conv = groupItem(item);
      if (!conv) continue;
      if (item.startsWith('[]')) policies.push(conv);
      else filters.push(conv);
    }
    const fields = [group.groupType, ...policies];
    if (!policies.length || FULL_NODE_SELECT.has(group.name)) {
      fields.push(...filters.map(f => `policy-regex-filter=${f}`));
    }
    return `${group.name} = ${fields.join(',')}`;
  }

  if (['url-test', 'fallback', 'load-balance', 'random'].includes(group.groupType)) {
    const regex = group.items[0] ?? '';
    const url = group.items[1] ?? 'http://www.gstatic.com/generate_204';
    let interval = '300', timeout = '', tolerance = '';
    if (group.items[2]) {
      const tp = group.items[2].split(',').map(p => p.trim());
      if (tp[0]) interval = tp[0];
      if (tp[1]) timeout = tp[1];
      if (tp[2]) tolerance = tp[2];
    }
    const fields = [group.groupType, `url=${url}`, `interval=${interval}`, 'select=0'];
    if (timeout) fields.push(`timeout=${timeout}`);
    if (tolerance) fields.push(`tolerance=${tolerance}`);
    if (regex) fields.push(`policy-regex-filter=${regex}`);
    return `${group.name} = ${fields.join(',')}`;
  }

  const fields = [group.groupType];
  for (const item of group.items) {
    const conv = groupItem(item);
    if (conv) fields.push(conv);
  }
  return `${group.name} = ${fields.join(',')}`;
}

// ─── Relay patching (chain proxy support) ────────────────────────────────────

const RELAY_REGION_GROUPS = [
  `🇭🇰 香港中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(香港|港|HK|Hong Kong).*$`,
  `🇹🇼 台湾中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(台湾|台北|TW|Taiwan).*$`,
  `🇸🇬 新加坡中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(新加坡|坡|狮城|SG|Singapore).*$`,
  `🇯🇵 日本中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(日本|东京|大阪|泉日|埼玉|JP|Japan).*$`,
  `🇺🇲 美国中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(美国|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|US|United States).*$`,
  `🇩🇪 德国中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(德国|DE|Germany).*$`,
  `🇬🇧 英国中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(英国|UK|United Kingdom).*$`,
  `🇦🇺 澳洲中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(澳洲|澳大利亚|AU|Australia).*$`,
].join('\n');

function patchGroupLine(line: string): string {
  if (!line.includes('policy-regex-filter=')) return line;
  return line.replace(/policy-regex-filter=(.+)$/, (_m, f: string) => {
    if (f === '.*') return `policy-regex-filter=${f}`;
    if (/PROXY@|DIRECT@|RELAY@/.test(f)) return `policy-regex-filter=${f}`;
    if (f.includes('^(?!')) return `policy-regex-filter=${f.replace('^(?!', '^PROXY@(?!')}`;
    return `policy-regex-filter=^PROXY@.*(${f})`;
  });
}

function generateProxyGroupSection(groups: ProxyGroup[]): string {
  const relayMain = `${RELAY_GROUP} = select,🇭🇰 香港中转,🇹🇼 台湾中转,🇸🇬 新加坡中转,🇯🇵 日本中转,🇺🇲 美国中转,🇩🇪 德国中转,🇬🇧 英国中转,🇦🇺 澳洲中转,DIRECT`;
  const groupLines = groups.map(g => patchGroupLine(convertProxyGroup(g)));
  return [relayMain, ...groupLines, '', RELAY_REGION_GROUPS].join('\n');
}

// ─── Rule section ─────────────────────────────────────────────────────────────

function generateRuleSection(rulesets: RuleSet[], selfBase: string): string {
  let urlIdx = 1;
  const lines: string[] = [];
  for (const rs of rulesets) {
    const { policy, target } = rs;
    if (target.startsWith('[]')) {
      const inline = target.slice(2);
      const parts = inline.split(',').map(p => p.trim()).filter(Boolean);
      lines.push(parts[0].toUpperCase() === 'FINAL' ? `FINAL,${policy}` : [...parts, policy].join(','));
    } else {
      lines.push(`RULE-SET,${selfBase}/ruleset/${urlIdx++}?t=shadowrocket,${policy}`);
    }
  }
  return lines.join('\n');
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

export async function generateShadowrocket(env: Env, selfBase: string, force = false): Promise<string> {
  const [ini, template] = await Promise.all([
    fetchFullIni(env, force),
    fetchRepoFile(env, 'shadowrocket/template.conf', force),
  ]);

  const rulesets = parseRuleSets(ini);
  const groups = parseProxyGroups(ini);

  const placeholders: Record<string, string> = {
    '{{PROXY_GROUP_SECTION}}': generateProxyGroupSection(groups),
    '{{RULE_SECTION}}': generateRuleSection(rulesets, selfBase),
  };

  let result = template;
  for (const [ph, value] of Object.entries(placeholders)) {
    if (!result.includes(ph)) throw new Error(`Missing template placeholder: ${ph}`);
    result = result.replace(ph, value);
  }

  return result.trimEnd() + '\n';
}
