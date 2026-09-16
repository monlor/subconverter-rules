import assert from 'node:assert/strict';
import test from 'node:test';

import { cachedFetch, fetchSubLines, parseSubCacheTtl, cacheKey } from '../dist/cache.js';
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

test('cachedFetch keeps stale subscription when upstream fails', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('alive', { status: 200 });
    return new Response('down', { status: 502 });
  };

  try {
    const kv = new MemoryKV();
    assert.equal(await cachedFetch(kv, 'https://example.test/sub'), 'alive');
    assert.equal(await cachedFetch(kv, 'https://example.test/sub', true), 'alive');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cachedFetch refetches after SUB_CACHE_TTL and keeps body on failure', async () => {
  const originalFetch = globalThis.fetch;
  const responses = ['first', 'second', null];
  let calls = 0;
  globalThis.fetch = async () => {
    const body = responses[calls++];
    if (body === null) return new Response('down', { status: 502 });
    return new Response(body, { status: 200 });
  };

  try {
    const kv = new MemoryKV();
    const url = 'https://example.test/sub';
    assert.equal(await cachedFetch(kv, url, false, 3600), 'first');
    const key = await cacheKey(url);
    await kv.put('subfresh:' + key.slice(6), String(Math.floor(Date.now() / 1000) - 10));
    assert.equal(await cachedFetch(kv, url, false, 5), 'second');
    await kv.put('subfresh:' + key.slice(6), String(Math.floor(Date.now() / 1000) - 10));
    assert.equal(await cachedFetch(kv, url, false, 5), 'second');
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parseSubCacheTtl defaults to 3600', () => {
  assert.equal(parseSubCacheTtl(undefined), 3600);
  assert.equal(parseSubCacheTtl(''), 3600);
  assert.equal(parseSubCacheTtl('0'), 0);
  assert.equal(parseSubCacheTtl('120'), 120);
  assert.equal(parseSubCacheTtl('-1'), 3600);
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
