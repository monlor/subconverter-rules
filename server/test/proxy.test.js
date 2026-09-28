import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProxyUri, toClashProxyYaml } from '../dist/proxy.js';

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
}

test('clash ssr keeps http_simple and strips _compatible', () => {
  const main = `1.2.3.4:443:auth_aes128_md5_compatible:aes-256-cfb:http_simple_compatible:${b64('pw')}/?obfsparam=${b64('example.com')}&remarks=${b64('ssr-node')}`;
  const yaml = toClashProxyYaml(parseProxyUri('ssr://' + b64(main)));
  assert.match(yaml, /protocol: "auth_aes128_md5"/);
  assert.match(yaml, /obfs: "http_simple"/);
  assert.match(yaml, /obfs-param: "example.com"/);
  assert.doesNotMatch(yaml, /_compatible/);
});

test('clash ss obfs drops modes mihomo rejects', () => {
  const user = Buffer.from('aes-256-gcm:secret', 'utf8').toString('base64url');
  const bad = parseProxyUri(`ss://${user}@1.2.3.4:8388/?plugin=${encodeURIComponent('obfs-local;obfs=tls1.2_ticket_auth;obfs-host=a.com')}#bad`);
  assert.equal(bad, null);
  const ok = parseProxyUri(`ss://${user}@1.2.3.4:8388/?plugin=${encodeURIComponent('obfs-local;obfs=tls;obfs-host=a.com')}#ok`);
  const yaml = toClashProxyYaml(ok);
  assert.match(yaml, /plugin: obfs/);
  assert.match(yaml, /mode: tls/);
  assert.match(yaml, /host: "a.com"/);
});

test('clash hysteria2 omits obfs without a password', () => {
  const yaml = toClashProxyYaml(parseProxyUri('hy2://secret@1.2.3.4:443?obfs=salamander#hy'));
  assert.doesNotMatch(yaml, /obfs/);
  const withPw = toClashProxyYaml(parseProxyUri('hy2://secret@1.2.3.4:443?obfs=salamander&obfs-password=abc#hy'));
  assert.match(withPw, /obfs: salamander/);
  assert.match(withPw, /obfs-password: "abc"/);
});
