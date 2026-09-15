import assert from 'node:assert/strict';
import test from 'node:test';

import { cachedFetch, fetchSubLines } from '../dist/cache.js';
import { MemoryKV } from '../dist/memory-kv.js';

test('cachedFetch reuses cached subscription content unless force is enabled', async () => {
  const originalFetch = globalThis.fetch;
  const responses = ['first', 'second'];
  let calls = 0;
  globalThis.fetch = async () => new Response(responses[calls++], { status: 200 });

  try {
    const kv = new MemoryKV();
    assert.equal(await cachedFetch(kv, 'https://example.test/sub'), 'first');
    assert.equal(await cachedFetch(kv, 'https://example.test/sub'), 'first');
    assert.equal(calls, 1);
    assert.equal(await cachedFetch(kv, 'https://example.test/sub', true), 'second');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSubLines accepts comma and newline separated subscription URLs', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return new Response(`trojan://pw@${new URL(String(url)).hostname}:443#node`, { status: 200 });
  };

  try {
    const lines = await fetchSubLines(
      new MemoryKV(),
      'https://one.test/sub\nhttps://two.test/sub, https://three.test/sub',
    );
    assert.deepEqual(requested, [
      'https://one.test/sub',
      'https://two.test/sub',
      'https://three.test/sub',
    ]);
    assert.equal(lines.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
