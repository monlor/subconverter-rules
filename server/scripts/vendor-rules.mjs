#!/usr/bin/env node
// Build-time only: pre-fetch every external (non-own-repo) ruleset referenced in
// full.ini into vendor/gh/<path>, so the running service never needs network
// access to GitHub. Own-repo rulesets are skipped (they're already in the tree).
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const GH_PROXY = 'https://gh.monlor.com/';
const OWN_REPO_PREFIX = 'https://raw.githubusercontent.com/monlor/subconverter-rules/main/';
const GH_RAW_PREFIX = 'https://raw.githubusercontent.com/';

function normalizeUrl(url) {
  return url.startsWith(GH_PROXY) ? url.slice(GH_PROXY.length) : url;
}

function parseRulesetUrls(ini) {
  const urls = [];
  for (const raw of ini.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (!line.startsWith('ruleset=')) continue;
    const payload = line.slice('ruleset='.length);
    const parts = payload.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const target = parts[1];
    if (target.startsWith('[]')) continue;
    urls.push(target);
  }
  return urls;
}

async function main() {
  const ini = readFileSync(join(ROOT, 'full.ini'), 'utf8');
  const urls = [...new Set(parseRulesetUrls(ini))];

  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  for (const rawUrl of urls) {
    const url = normalizeUrl(rawUrl);
    if (url.startsWith(OWN_REPO_PREFIX)) {
      skipped++;
      continue;
    }
    if (!url.startsWith(GH_RAW_PREFIX)) {
      console.warn(`Skipping unsupported ruleset source: ${rawUrl}`);
      continue;
    }

    const relPath = url.slice(GH_RAW_PREFIX.length);
    const destPath = join(ROOT, 'vendor', 'gh', relPath);

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, text, 'utf8');
      fetched++;
      console.log(`vendored: ${relPath}`);
    } catch (e) {
      failed++;
      console.error(`FAILED to vendor ${url}: ${String(e)}`);
      if (existsSync(destPath)) {
        console.error(`  (keeping existing snapshot at vendor/gh/${relPath})`);
      }
    }
  }

  console.log(`\nDone. fetched=${fetched} skipped(own-repo)=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main();
