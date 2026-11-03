import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProxyUri, toClashProxyYaml, toSurgeLine } from '../dist/proxy.js';
import { toLoonLine } from '../dist/loon.js';

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
}

test('SS Shadowrocket obfs parameters survive parsing and client conversion', () => {
  const authorities = [
    `${b64('aes-128-gcm:test-password')}@ss.test:8388`,
    b64('aes-128-gcm:test-password@ss.test:8388'),
  ];
  for (const authority of authorities) {
    for (const mode of ['http', 'tls']) {
      const proxy = parseProxyUri(`ss://${authority}/?obfs=${mode}&obfsParam=cdn.test#SS`);
      assert(proxy);
      assert.equal(proxy.plugin, 'obfs');
      assert.equal(proxy.pluginMode, mode);
      assert.equal(proxy.pluginHost, 'cdn.test');
      assert.match(toSurgeLine(proxy), new RegExp(`obfs=${mode}, obfs-host=cdn.test`));
      assert.match(toLoonLine(proxy), new RegExp(`obfs-name=${mode},obfs-host=cdn.test,`));
      assert.match(toClashProxyYaml(proxy), new RegExp(`mode: ${mode}`));
      assert.match(toClashProxyYaml(proxy), /host: "cdn.test"/);
    }
  }
});

test('SS SIP002 obfs works for legacy authorities and preserves plugin path values', () => {
  for (const plugin of ['obfs-local', 'simple-obfs']) {
    for (const authority of [`${b64('aes-128-gcm:pw')}@ss.test:8388`, b64('aes-128-gcm:pw@ss.test:8388')]) {
      const options = `${plugin};obfs=http;obfs-host=cdn.test;obfs-uri=/request?token=a=b@c`;
      const proxy = parseProxyUri(`ss://${authority}/?plugin=${encodeURIComponent(options)}#SS`);
      assert(proxy);
      assert.equal(proxy.server, 'ss.test');
      assert.equal(proxy.pluginHost, 'cdn.test');
      assert.equal(proxy.pluginPath, '/request?token=a=b@c');
    }
  }
});

test('SS obfs mode validation applies to Shadowrocket options without changing plain SS', () => {
  const authority = `${b64('aes-128-gcm:pw')}@ss.test:8388`;
  for (const query of ['', '?obfs=none']) {
    const proxy = parseProxyUri(`ss://${authority}${query}#SS`);
    assert(proxy);
    assert.equal(proxy.plugin, undefined);
    assert.doesNotMatch(toSurgeLine(proxy), /obfs/);
    assert.doesNotMatch(toLoonLine(proxy), /obfs/);
  }
  assert.equal(parseProxyUri(`ss://${authority}?obfs=tls1.2_ticket_auth#SS`), null);
  const plugin = encodeURIComponent('obfs-local;obfs=tls;obfs-host=plugin.test');
  const proxy = parseProxyUri(`ss://${authority}?plugin=${plugin}&obfs=http&obfsParam=other.test#SS`);
  assert.equal(proxy.pluginMode, 'tls');
  assert.equal(proxy.pluginHost, 'plugin.test');
});

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
