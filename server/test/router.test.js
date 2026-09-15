import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest } from '../dist/router.js';
import { MemoryKV } from '../dist/memory-kv.js';

test('router generates all client formats without fetching GitHub', async () => {
  const env = {
    SECRET_KEY: 'test-key',
    PROXY_SUBS: 'trojan://pw@example.test:443?sni=example.test#landing',
    RELAY_SUBS: '',
    CACHE: new MemoryKV(),
  };
  const cases = [
    ['/config?key=test-key', '[Proxy Group]'],
    ['/config?key=test-key&target=surge', '[Proxy]'],
    ['/config?key=test-key&target=clash', 'rule-providers:'],
    ['/ruleset/1?t=shadowrocket', 'DOMAIN'],
  ];

  for (const [path, marker] of cases) {
    const response = await handleRequest(new Request(`http://subhub.test${path}`), env);
    const body = await response.text();
    assert.equal(response.status, 200, path);
    assert.match(body, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), path);
  }
});
