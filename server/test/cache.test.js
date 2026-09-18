import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cachedFetch, fetchSubLines, fetchUserinfo, getSubscriptionDiagnostic, parseSubCacheTtl, cacheKey } from '../dist/cache.js';
import { MemoryKV } from '../dist/memory-kv.js';

const NODE = (name) => `trojan://pw@${name}.test:443#${name}`;

test('cachedFetch reuses cached subscription content unless force is enabled', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [NODE('first'), NODE('second')];
  let calls = 0;
  globalThis.fetch = async () => new Response(responses[calls++], { status: 200 });

  try {
    const kv = new MemoryKV();
    assert.equal(await cachedFetch(kv, 'https://example.test/sub'), NODE('first'));
    assert.equal(await cachedFetch(kv, 'https://example.test/sub'), NODE('first'));
    assert.equal(calls, 1);
    assert.equal(await cachedFetch(kv, 'https://example.test/sub', true), NODE('second'));
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
    if (calls === 1) return new Response(NODE('alive'), { status: 200 });
    return new Response('down', { status: 502 });
  };

  try {
    const kv = new MemoryKV();
    assert.equal(await cachedFetch(kv, 'https://example.test/sub'), NODE('alive'));
    assert.equal(await cachedFetch(kv, 'https://example.test/sub', true), NODE('alive'));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cachedFetch keeps stale subscription when upstream returns empty or non-node body', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [NODE('relay'), '', 'not a subscription', '<html>blocked</html>'];
  let calls = 0;
  globalThis.fetch = async () => new Response(responses[calls++], { status: 200 });

  try {
    const kv = new MemoryKV();
    const url = 'https://example.test/relay';
    assert.equal(await cachedFetch(kv, url), NODE('relay'));
    assert.equal(await cachedFetch(kv, url, true), NODE('relay'));
    assert.equal(await cachedFetch(kv, url, true), NODE('relay'));
    assert.equal(await cachedFetch(kv, url, true), NODE('relay'));
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cachedFetch records sanitized diagnostics for every upstream result', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    switch (new URL(String(url)).hostname) {
      case 'http.test': return new Response('down', { status: 503 });
      case 'empty.test': return new Response('', { status: 200 });
      case 'invalid.test': return new Response('<html>blocked</html>', { status: 200 });
      case 'network.test': throw new TypeError('fetch failed');
      default: return new Response(NODE('alive'), { status: 200 });
    }
  };

  try {
    const kv = new MemoryKV();
    for (const [url, outcome] of [
      ['https://http.test/sub', 'http_error'],
      ['https://empty.test/sub', 'empty_body'],
      ['https://invalid.test/sub', 'no_proxy_uri'],
      ['https://network.test/sub', 'network_error'],
      ['https://success.test/sub', 'success'],
    ]) {
      await cachedFetch(kv, url, true);
      const diagnostic = await getSubscriptionDiagnostic(kv, url);
      assert.equal(diagnostic?.outcome, outcome);
      assert.equal(diagnostic?.cached, outcome === 'success');
    }

    const httpDiagnostic = await getSubscriptionDiagnostic(kv, 'https://http.test/sub');
    assert.equal(httpDiagnostic?.httpStatus, 503);
    const networkDiagnostic = await getSubscriptionDiagnostic(kv, 'https://network.test/sub');
    assert.equal(networkDiagnostic?.errorType, 'TypeError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cachedFetch refetches after SUB_CACHE_TTL and keeps body on failure', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [NODE('first'), NODE('second'), null];
  let calls = 0;
  globalThis.fetch = async () => {
    const body = responses[calls++];
    if (body === null) return new Response('down', { status: 502 });
    return new Response(body, { status: 200 });
  };

  try {
    const kv = new MemoryKV();
    const url = 'https://example.test/sub';
    assert.equal(await cachedFetch(kv, url, false, 3600), NODE('first'));
    const key = await cacheKey(url);
    await kv.put('subfresh:' + key.slice(6), String(Math.floor(Date.now() / 1000) - 10));
    assert.equal(await cachedFetch(kv, url, false, 5), NODE('second'));
    await kv.put('subfresh:' + key.slice(6), String(Math.floor(Date.now() / 1000) - 10));
    assert.equal(await cachedFetch(kv, url, false, 5), NODE('second'));
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cachedFetch preserves the last fetch diagnostic when TTL serves cache', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(NODE(`cache-${++calls}`), { status: 200 });

  try {
    const kv = new MemoryKV();
    const url = 'https://example.test/cache';
    await cachedFetch(kv, url, false, 3600);
    const first = await getSubscriptionDiagnostic(kv, url);
    await cachedFetch(kv, url, false, 3600);
    assert.equal(calls, 1);
    assert.deepEqual(await getSubscriptionDiagnostic(kv, url), first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MemoryKV reloads last good subscription from disk after restart', async () => {
  const originalFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'subhub-kv-'));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(NODE('persisted'), { status: 200 });
    return new Response('', { status: 502 });
  };

  try {
    const url = 'https://example.test/relay';
    const kv1 = new MemoryKV(dir);
    assert.equal(await cachedFetch(kv1, url), NODE('persisted'));

    const kv2 = new MemoryKV(dir);
    assert.equal(await cachedFetch(kv2, url, true), NODE('persisted'));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cachedFetch and fetchUserinfo send Shadowrocket User-Agent', async () => {
  const originalFetch = globalThis.fetch;
  const userAgents = [];
  globalThis.fetch = async (_url, init) => {
    userAgents.push(new Headers(init?.headers).get('User-Agent'));
    return new Response(NODE('ua'), {
      status: 200,
      headers: { 'subscription-userinfo': 'upload=1; download=2; total=3; expire=4' },
    });
  };

  try {
    const kv = new MemoryKV();
    await cachedFetch(kv, 'https://example.test/sub', true);
    await fetchUserinfo(kv, 'https://example.test/info', true);
    assert.equal(userAgents.length, 2);
    for (const ua of userAgents) {
      assert.match(ua, /Shadowrocket/i);
      assert.doesNotMatch(ua, /ClashForAndroid/i);
    }
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
