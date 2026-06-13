import { Env } from './types.js';
import { cachedFetch } from './cache.js';

const DEFAULT_BASE_URL =
  'https://raw.githubusercontent.com/monlor/subconverter-rules/main/shadowrocket/full.conf';

export async function generateConfig(env: Env, force = false): Promise<string> {
  const baseUrl = (env as any).BASE_CONFIG_URL || DEFAULT_BASE_URL;
  const baseText = await cachedFetch(env.CACHE, baseUrl, force);
  if (!baseText) throw new Error(`Failed to fetch base config: ${baseUrl}`);

  const sections = parseConfigSections(baseText);

  // [Proxy] section is empty — nodes come from the /sub subscription
  sections.set('Proxy', '# Nodes are loaded from the /sub subscription URL\n');
  sections.set('Proxy Group', patchProxyGroups(sections.get('Proxy Group') || ''));

  return assembleConfig(sections);
}

// ---------------------------------------------------------------------------

function parseConfigSections(text: string): Map<string, string> {
  const lineMap = new Map<string, string[]>();
  let current = '_preamble_';
  lineMap.set(current, []);

  for (const line of text.split('\n')) {
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      current = m[1];
      if (!lineMap.has(current)) lineMap.set(current, []);
    } else {
      lineMap.get(current)!.push(line);
    }
  }

  const sections = new Map<string, string>();
  for (const [name, lines] of lineMap) sections.set(name, lines.join('\n'));
  return sections;
}

function assembleConfig(sections: Map<string, string>): string {
  const parts: string[] = [];
  for (const [name, content] of sections) {
    if (name === '_preamble_') {
      const t = content.trimEnd();
      if (t) parts.push(t);
      continue;
    }
    parts.push(`[${name}]`);
    const t = content.trimEnd();
    if (t) parts.push(t);
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------

const RELAY_GROUP = '🔀 中转代理';
const RELAY_EXCLUDE = '家宽|5G网络|星链|住宅|游戏|抓包|HOME|GAME|FORWARD|实验';
const RELAY_FILTER = `(?i)^RELAY@(?!.*(${RELAY_EXCLUDE})).*`;
const RELAY_REGION_GROUPS = `# Relay region groups
🇭🇰 香港中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(香港|港|HK|Hong Kong).*$
🇹🇼 台湾中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(台湾|台北|TW|Taiwan).*$
🇸🇬 新加坡中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(新加坡|坡|狮城|SG|Singapore).*$
🇯🇵 日本中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(日本|东京|大阪|泉日|埼玉|JP|Japan).*$
🇺🇲 美国中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(美国|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|US|United States).*$
🇩🇪 德国中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(德国|DE|Germany).*$
🇬🇧 英国中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(英国|UK|United Kingdom).*$
🇦🇺 澳洲中转 = url-test,url=http://www.gstatic.com/generate_204,interval=300,select=0,tolerance=50,policy-regex-filter=${RELAY_FILTER}(澳洲|澳大利亚|AU|Australia).*$`;

function patchProxyGroups(content: string): string {
  const relayMain = `${RELAY_GROUP} = select,🇭🇰 香港中转,🇹🇼 台湾中转,🇸🇬 新加坡中转,🇯🇵 日本中转,🇺🇲 美国中转,🇩🇪 德国中转,🇬🇧 英国中转,🇦🇺 澳洲中转,DIRECT`;
  const patched: string[] = [];
  let inserted = false;

  for (const line of content.split('\n')) {
    if (!inserted && line.trim() && !line.trim().startsWith('#')) {
      patched.push(relayMain);
      inserted = true;
    }
    patched.push(patchGroupLine(line));
  }

  patched.push('', RELAY_REGION_GROUPS);
  return patched.join('\n');
}

function patchGroupLine(line: string): string {
  if (!line.includes('policy-regex-filter=')) return line;
  return line.replace(/policy-regex-filter=(.+)$/, (_m, f: string) => {
    // .* — 手动选择/VoWiFi，保持不变，允许所有节点
    if (f === '.*') return `policy-regex-filter=${f}`;
    // 已有前缀（PROXY@/DIRECT@/RELAY@）— 保持不变
    if (/PROXY@|DIRECT@|RELAY@/.test(f)) return `policy-regex-filter=${f}`;
    // 负向前瞻模式（自动选择/地区节点）— 只匹配 PROXY@ 节点
    if (f.includes('^(?!')) {
      return `policy-regex-filter=${f.replace('^(?!', '^PROXY@(?!')}`;
    }
    // 其他关键词过滤 — 只匹配 PROXY@ 节点
    return `policy-regex-filter=^PROXY@.*(${f})`;
  });
}
