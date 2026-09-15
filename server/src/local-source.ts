import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/local-source.js -> server/ -> repo root
export const ROOT = join(__dirname, '..', '..');

const GH_PROXY = 'https://gh.monlor.com/';
const OWN_REPO_PREFIX = 'https://raw.githubusercontent.com/monlor/subconverter-rules/main/';
const GH_RAW_PREFIX = 'https://raw.githubusercontent.com/';

/** Strip the gh.monlor.com proxy prefix to get the real raw.githubusercontent.com URL. */
export function normalizeUrl(url: string): string {
  return url.startsWith(GH_PROXY) ? url.slice(GH_PROXY.length) : url;
}

/**
 * Map a ruleset/template URL (as written in full.ini) to its local on-disk path.
 * Own-repo URLs resolve directly into the checked-out tree; everything else must
 * have been pre-fetched into vendor/gh/<path> by scripts/vendor-rules.mjs.
 */
export function resolveLocalPath(url: string): string {
  const normalized = normalizeUrl(url);
  if (normalized.startsWith(OWN_REPO_PREFIX)) {
    return join(ROOT, normalized.slice(OWN_REPO_PREFIX.length));
  }
  if (normalized.startsWith(GH_RAW_PREFIX)) {
    return join(ROOT, 'vendor', 'gh', normalized.slice(GH_RAW_PREFIX.length));
  }
  throw new Error(`Unsupported ruleset source (not GitHub-raw): ${url}`);
}

export function readFullIni(): string {
  return readFileSync(join(ROOT, 'full.ini'), 'utf8');
}

export function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

export interface RulesetSource {
  content: string;
  vendored: boolean; // false = own repo file, true = vendor/gh snapshot
  path: string;
  mtime: Date;
}

/** Read a ruleset's content from local disk. Throws with a clear message if not vendored yet. */
export function readRulesetSource(url: string): RulesetSource {
  const path = resolveLocalPath(url);
  if (!existsSync(path)) {
    throw new Error(
      `Ruleset not found locally: ${path}\n` +
      `Run "npm run vendor" (server/scripts/vendor-rules.mjs) and rebuild the image to fetch it.`,
    );
  }
  return {
    content: readFileSync(path, 'utf8'),
    vendored: !normalizeUrl(url).startsWith(OWN_REPO_PREFIX),
    path,
    mtime: statSync(path).mtime,
  };
}
