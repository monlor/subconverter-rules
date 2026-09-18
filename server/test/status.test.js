import assert from 'node:assert/strict';
import test from 'node:test';

import { cachedFetch } from '../dist/cache.js';
import { MemoryKV } from '../dist/memory-kv.js';
import { handleStatus } from '../dist/status.js';

test('status reports a sanitized failed subscription fetch', async () => {
  const originalFetch = globalThis.fetch;
  const url = 'https://provider.example.test/sub?token=secret-token';
  globalThis.fetch = async () => new Response('', { status: 200 });

  try {
    const cache = new MemoryKV();
    await cachedFetch(cache, url, true);

    const response = await handleStatus({
      SECRET_KEY: 'test-key',
      PROXY_SUBS: url,
      RELAY_SUBS: '',
      CACHE: cache,
    }, 'https://subhub.example.test', 'test-key');
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(body.subscriptions.PROXY_SUBS.length, 1);
    assert.equal(body.subscriptions.PROXY_SUBS[0].index, 1);
    assert.equal(body.subscriptions.PROXY_SUBS[0].outcome, 'empty_body');
    assert.equal(body.subscriptions.PROXY_SUBS[0].cached, false);
    assert.ok(Date.parse(body.subscriptions.PROXY_SUBS[0].lastAttemptAt));
    assert.deepEqual(body.subscriptions.RELAY_SUBS, []);
    assert.doesNotMatch(serialized, /provider\.example\.test|secret-token|test-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
