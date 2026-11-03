import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handleRequest } from '../dist/router.js';
import { MemoryKV } from '../dist/memory-kv.js';

function section(config, name) {
  return config.split(`[${name}]`)[1].split(/\n\[/)[0].split('\n')
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

function summarize(content, options = []) {
  const rules = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const effective = rules.map(line => {
    if (options.includes('no-resolve') && /^(IP-CIDR|IP-CIDR6|GEOIP|IP-ASN),/.test(line) &&
        !line.split(',').includes('no-resolve')) return `${line},no-resolve`;
    return line;
  });
  return { count: effective.length, hash: createHash('sha256').update(effective.join('\n')).digest('hex') };
}

test('every Loon ruleset matches Surge content, ordering, policies and effective options', async () => {
  const env = {
    SECRET_KEY: 'test', PROXY_SUBS: 'trojan://pw@example.test:443#HK', RELAY_SUBS: '', CACHE: new MemoryKV(),
  };
  async function read(url) {
    const response = await handleRequest(new Request(url), env);
    assert.equal(response.status, 200, url);
    return response.text();
  }
  const surge = await read('http://subhub.test/config?key=test&target=surge');
  const loon = await read('http://subhub.test/config?key=test&target=loon');
  const reference = [];
  for (const line of section(surge, 'Rule')) {
    const [type, ...parts] = line.split(',');
    if (type === 'RULE-SET') {
      const [url, policy, ...options] = parts;
      reference.push({ policy, ...summarize(await read(url), options) });
    } else {
      const policy = parts.pop();
      reference.push({ policy, ...summarize([type, ...parts].join(',')) });
    }
  }
  const actual = [];
  for (const line of section(loon, 'Remote Rule')) {
    const [url, ...attributes] = line.split(',');
    const policy = attributes.find(attribute => attribute.startsWith('policy=')).slice('policy='.length);
    actual.push({ policy, ...summarize(await read(url)) });
  }
  for (const line of section(loon, 'Rule')) {
    const parts = line.split(',');
    const policy = parts.pop();
    actual.push({ policy, ...summarize(parts.join(',')) });
  }
  assert.equal(actual.length, reference.length, 'ruleset and inline-rule coverage');
  for (let i = 0; i < reference.length; i++) {
    assert.deepEqual(actual[i], reference[i], `rule entry ${i + 1}: ${reference[i].policy}`);
  }
  const source = readFileSync(new URL('../../full.ini', import.meta.url), 'utf8');
  assert.equal(reference.length, source.split('\n').filter(line => line.startsWith('ruleset=')).length);
  const groups = new Set(section(loon, 'Proxy Group').map(line => line.split(' = ')[0]));
  for (const entry of actual) {
    assert(groups.has(entry.policy) || ['DIRECT', 'REJECT'].includes(entry.policy), `missing policy ${entry.policy}`);
  }
});
