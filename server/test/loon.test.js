import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../dist/router.js';
import { MemoryKV } from '../dist/memory-kv.js';
import { toLoonLine } from '../dist/loon.js';
import { parseProxyUri } from '../dist/proxy.js';
import { parseRuleSets, urlRuleSets, loonRemoteRuleSets } from '../dist/ini.js';
import { readFileSync } from 'node:fs';
import { convertRulesetContent } from '../dist/ruleset.js';

function env(relay = '') {
  return { SECRET_KEY: 'test', PROXY_SUBS: 'trojan://pw@landing.test:443#HK', RELAY_SUBS: relay, CACHE: new MemoryKV() };
}

test('Loon UA and explicit target return remote rule entries bound to original policies', async () => {
  for (const [query, ua] of [['&target=loon', 'Surge'], ['', 'Loon/3.5']]) {
    const res = await handleRequest(new Request(`http://subhub.test/config?key=test${query}`, { headers: { 'User-Agent': ua } }), env());
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /HK = Trojan,landing.test,443,"pw"/);
    assert.match(text, /\[Proxy Chain\]/);
    assert.match(text, /\[Rule\]\nFINAL,🐟 其他服务\n/);
    assert.doesNotMatch(text, /RULE-SET|underlying-proxy|include-other-group|\{\{/);
    const entries = text.split('[Remote Rule]')[1].split('\n[')[0].trim().split('\n');
    const expected = loonRemoteRuleSets(parseRuleSets(readFileSync(new URL('../../full.ini', import.meta.url), 'utf8')));
    assert.equal(entries.length, expected.length);
    for (let i = 0; i < entries.length; i++) {
      assert(entries[i].startsWith(`http://subhub.test/ruleset/${i + 1}-`));
      assert(entries[i].includes(`?t=loon,policy=${expected[i].policy},tag=`));
      assert(entries[i].endsWith('enabled=true'));
    }
    assert.doesNotMatch(text, /PROCESS-NAME,CGEData|DOMAIN-SUFFIX,plex.tv|DEST-PORT,22,/);
    assert(text.length < 100000);
    assert(entries.at(-1).includes('-geoip-cn?t=loon,policy=🇨🇳 中国直连,'));
  }
});

test('public Loon rulesets use native aliases and preserve source no-resolve options', async () => {
  const request = path => new Request(`http://subhub.test${path}`);
  const portSets = urlRuleSets(parseRuleSets(readFileSync(new URL('../../full.ini', import.meta.url), 'utf8')));
  const index = portSets.findIndex(rs => rs.policy === '🔌 常见端口') + 1;
  const portResponse = await handleRequest(request(`/ruleset/${index}-tcpports?t=loon`), env());
  assert.equal(portResponse.status, 200);
  assert.match(await portResponse.text(), /DEST-PORT,22/);
  const whitelist = await handleRequest(request('/ruleset/2-whitelist?t=loon'), env());
  assert.equal(whitelist.status, 200);
  const body = await whitelist.text();
  assert.match(body, /IP-CIDR,45.121.184.0\/24,no-resolve/);
  assert.match(body, /DOMAIN-SUFFIX,plex.tv\n/);
  assert.doesNotMatch(body, /no-resolve,no-resolve|🇨🇳 中国直连/);
  const srResponse = await handleRequest(request(`/ruleset/${index}?t=shadowrocket`), env());
  assert.match(await srResponse.text(), /DST-PORT,22/);
  const fallbackIndex = portSets.length + 1;
  const fallback = await handleRequest(request(`/ruleset/${fallbackIndex}-geoip-cn?t=loon`), env());
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), 'GEOIP,CN\n');
  const srFallback = await handleRequest(request(`/ruleset/${fallbackIndex}?t=surge`), env());
  assert.equal(srFallback.status, 404);
});

test('Loon ruleset conversion normalizes YAML and applies no-resolve only to IP rules', () => {
  const source = "payload:\n - 'DST-PORT,443'\n - DOMAIN,example.test\n - IP-CIDR,192.0.2.0/24\n - IP-CIDR6,2001:db8::/32,no-resolve";
  assert.equal(convertRulesetContent(source, 'loon', ['no-resolve']),
    'DEST-PORT,443\nDOMAIN,example.test\nIP-CIDR,192.0.2.0/24,no-resolve\nIP-CIDR6,2001:db8::/32,no-resolve\n');
});

test('Loon follows Surge group structure with regional relays and DIRECT bypass', async () => {
  const configEnv = env('trojan://pw@relay.test:443#HK-1x\ntrojan://pw@relay2.test:443#SG-1x');
  configEnv.PROXY_SUBS += '\ntrojan://pw@landing2.test:443#US';
  const res = await handleRequest(new Request('http://subhub.test/config?key=test&target=loon'), configEnv);
  const text = await res.text();
  assert.equal(res.status, 200);
  const groupText = text.split('[Proxy Group]')[1].split('[Proxy Chain]')[0];
  assert.match(text, /HK = 🔀 中转代理,LANDING@HK,udp=false/);
  assert.match(text, /US = 🔀 中转代理,LANDING@US,udp=false/);
  assert.match(text, /LANDING@HK = Trojan,landing.test,443/);
  assert.match(groupText, /🔀 中转代理 = select,🇭🇰 香港中转,🇸🇬 新加坡中转,DIRECT/);
  assert.match(groupText, /代理节点 = select,HK,US/);
  assert.match(groupText, /中转节点 = select,HK-1x,SG-1x/);
  assert.match(groupText, /🇭🇰 香港中转 = url-test,HK-1x,url=.*interval=300,tolerance=50/);
  assert.match(groupText, /🇸🇬 新加坡中转 = url-test,SG-1x,url=/);
  assert.match(groupText, /♻️ 自动选择 = url-test,HK,US,url=/);
  assert.match(groupText, /🚀 手动选择 = select,HK,US,HK-1x,SG-1x/);
  assert.match(groupText, /📶 VoWiFi = select,DIRECT,HK,US,HK-1x,SG-1x/);
  assert.doesNotMatch(text, /DIRECT@|CHAIN@|via |HK = select/);
  assert.doesNotMatch(groupText, /LANDING@|🇺🇲 美国中转|🇯🇵 日本中转|CELLULAR-ONLY|中转网卡|蜂窝流量/);
});

test('unsupported relay protocols do not create dangling chains', async () => {
  const relay = 'tuic://id:pw@relay.test:443#unsupported';
  const res = await handleRequest(new Request('http://subhub.test/config?key=test&target=loon'), env(relay));
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /HK = Trojan/);
  assert.doesNotMatch(text, /CHAIN@|RELAY@unsupported/);
});

test('native Loon conversion preserves TLS, credentials, Reality and obfuscation', () => {
  assert.match(toLoonLine(parseProxyUri('trojan://pw@node.test:443?type=ws&path=%2Fws&host=cdn.test&sni=sni.test&allowInsecure=1#node')), /transport=ws,path="\/ws",host="cdn.test",sni="sni.test",skip-cert-verify=true/);
  assert.match(toLoonLine(parseProxyUri('vless://id@node.test:443?security=reality&pbk=key&sid=abc&sni=sni.test&flow=xtls-rprx-vision#node')), /public-key="key",short-id="abc"/);
  assert.match(toLoonLine(parseProxyUri('hy2://pw@node.test:443?obfs=salamander&obfs-password=secret#node')), /salamander-password="secret"/);
  assert.equal(toLoonLine(parseProxyUri('vless://id@node.test:443?type=grpc#node')), null);
  assert.equal(toLoonLine(parseProxyUri('tuic://id:pw@node.test:443#node')), null);
  const vmess = 'vmess://' + Buffer.from(JSON.stringify({ add: 'node.test', port: 443, id: 'id', scy: 'chacha20-ietf-poly1305', net: 'ws', tls: 'tls', path: '/ws', host: 'cdn.test' })).toString('base64');
  assert.match(toLoonLine(parseProxyUri(vmess)), /VMess,node.test,443,chacha20-ietf-poly1305,"id"/);
  assert.match(toLoonLine(parseProxyUri('vless://id@node.test:443?type=http&path=%2Fx&host=cdn.test#node')), /transport=http,path="\/x",host="cdn.test"/);
  assert.match(toLoonLine(parseProxyUri('anytls://pw@node.test:443#node')), /AnyTLS,node.test,443,"pw"/);
});

test('duplicate and reserved node names remain unique with valid references', async () => {
  const configEnv = env('trojan://pw@relay.test:443#Relay-1x');
  configEnv.PROXY_SUBS = 'trojan://pw@one.test:443#DIRECT\ntrojan://pw@two.test:443#DIRECT\nhy2://pw@three.test:443#UDP';
  const response = await handleRequest(new Request('http://subhub.test/config?key=test&target=loon'), configEnv);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /DIRECT \(2\) = 🔀 中转代理,/);
  assert.match(text, /DIRECT \(3\) = 🔀 中转代理,/);
  assert.match(text, /UDP = Hysteria2/);
  assert.doesNotMatch(text, /DIRECT@UDP/);
  const names = [...text.matchAll(/^(.+?) = /gm)].map(m => m[1]);
  assert.equal(names.length, new Set(names).size);
});

test('relay filtering defaults exclude residential nodes and require an exact 1x multiplier', async () => {
  const names = ['HK 1x', 'SG 1X', 'JP 1.0x', 'US 1×', '香港家宽 1x', '住宅 1x', 'HOME 1x', 'HK 0.1x', 'HK 11x', 'HK 2x', 'HK 1x2', 'HK 1x.5', 'HK'];
  const configEnv = env(names.map((name, i) => `trojan://pw@relay${i}.test:443#${encodeURIComponent(name)}`).join('\n'));
  const res = await handleRequest(new Request('http://subhub.test/config?key=test&target=loon'), configEnv);
  const text = await res.text();
  assert.equal(res.status, 200);
  const nodes = text.split('[Proxy]')[1].split('[Proxy Group]')[0];
  for (const name of names.slice(0, 4)) assert(nodes.split('\n').some(line => line.startsWith(`${name} = `)), name);
  for (const name of names.slice(4)) assert(!nodes.split('\n').some(line => line.startsWith(`${name} = `)), name);
});

test('unrecognized relay regions remain selectable and generated groups have no missing references', async () => {
  for (const names of [['Other-1x'], ['HK-1x', 'SG-1x', 'US-1x', 'JP-1x']]) {
    const configEnv = env(names.map((name, i) => `trojan://pw@relay${i}.test:443#${name}`).join('\n'));
    const res = await handleRequest(new Request('http://subhub.test/config?key=test&target=loon'), configEnv);
    assert.equal(res.status, 200);
    const text = await res.text();
    const definitions = new Set(['DIRECT', 'REJECT', 'PROXY', ...[...text.matchAll(/^(.+?) = /gm)].map(m => m[1])]);
    for (const section of ['Proxy Group', 'Proxy Chain']) {
      const content = text.split(`[${section}]`)[1].split('\n[')[0];
      for (const line of content.split('\n').filter(line => line.includes(' = '))) {
        const fields = line.split(' = ')[1].split(',');
        const references = section === 'Proxy Group' ? fields.slice(1) : fields;
        for (const ref of references.filter(field => !field.includes('='))) {
          assert(definitions.has(ref), `missing ${ref} in ${line}`);
        }
      }
    }
    if (names.length === 1) assert.match(text, /🔀 中转代理 = select,中转节点,DIRECT/);
    else assert.match(text, /🔀 中转代理 = select,🇭🇰 香港中转,🇸🇬 新加坡中转,🇺🇲 美国中转,🇯🇵 日本中转,DIRECT/);
  }
});

test('relay include/exclude regexes can be overridden or disabled independently', async () => {
  const configEnv = env('trojan://pw@a.test:443#HK-2x\ntrojan://pw@b.test:443#SG-2x\ntrojan://pw@c.test:443#HOME-1x');
  configEnv.LOON_RELAY_INCLUDE_REGEX = '2x';
  configEnv.LOON_RELAY_EXCLUDE_REGEX = 'SG';
  const request = () => new Request('http://subhub.test/config?key=test&target=loon');
  let text = await (await handleRequest(request(), configEnv)).text();
  assert.match(text, /HK-2x = Trojan/);
  assert.doesNotMatch(text, /^SG-2x = |^HOME-1x = /m);
  configEnv.LOON_RELAY_INCLUDE_REGEX = '';
  configEnv.LOON_RELAY_EXCLUDE_REGEX = '';
  text = await (await handleRequest(request(), configEnv)).text();
  assert.match(text, /HK-2x = Trojan/);
  assert.match(text, /SG-2x = Trojan/);
  assert.match(text, /HOME-1x = Trojan/);
});

test('empty relay matches leave direct nodes and invalid regexes report the variable', async () => {
  const configEnv = env('trojan://pw@a.test:443#HK-2x');
  const request = () => new Request('http://subhub.test/config?key=test&target=loon');
  let res = await handleRequest(request(), configEnv);
  let text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /HK = Trojan/);
  assert.doesNotMatch(text, /HK = 🔀/);
  assert.match(text, /🔀 中转代理 = select,DIRECT/);
  assert.match(text, /No eligible relay/);
  configEnv.LOON_RELAY_INCLUDE_REGEX = '[';
  res = await handleRequest(request(), configEnv);
  assert.equal(res.status, 500);
  text = await res.text();
  assert.match(text, /LOON_RELAY_INCLUDE_REGEX/);
});
