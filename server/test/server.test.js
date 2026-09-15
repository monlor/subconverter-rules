import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubhubServer, loadEnv } from '../dist/server.js';
import { MemoryKV } from '../dist/memory-kv.js';

test('loadEnv rejects startup without PROXY_SUBS', () => {
  assert.throws(() => loadEnv({}), /PROXY_SUBS is required/);
});

test('HTTP server rejects unsupported methods before routing', async () => {
  const server = createSubhubServer({
    SECRET_KEY: 'test-key',
    PROXY_SUBS: 'trojan://pw@example.test:443#node',
    RELAY_SUBS: '',
    CACHE: new MemoryKV(),
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/config?key=test-key`, {
      method: 'POST',
      body: 'ignored',
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
