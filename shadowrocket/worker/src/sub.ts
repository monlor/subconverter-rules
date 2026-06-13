import { Env, PROXYPASS_UNSUPPORTED } from './types.js';
import { getSubContent, decodeBase64 } from './cache.js';

const CHAIN = '🔀 中转代理';

export async function generateSub(env: Env, force = false): Promise<string> {
  const lines: string[] = [];

  for (const sub of splitSubs(env.PROXY_SUBS)) {
    for (const uri of await fetchURIs(env, sub, force)) {
      const proto = getProto(uri);
      if (proto && PROXYPASS_UNSUPPORTED.has(proto)) {
        lines.push(rename(uri, 'DIRECT@'));
      } else {
        lines.push(addChain(rename(uri, 'PROXY@')));
      }
    }
  }

  for (const sub of splitSubs(env.RELAY_SUBS)) {
    for (const uri of await fetchURIs(env, sub, force)) {
      lines.push(rename(uri, 'RELAY@'));
    }
  }

  return btoa(unescape(encodeURIComponent(lines.join('\n'))));
}

async function fetchURIs(env: Env, sub: string, force: boolean): Promise<string[]> {
  const text = await getSubContent(env.CACHE, sub, force);
  if (!text) return [];
  const content = decodeBase64(text) ?? text;
  return content.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.includes('://'));
}

function getProto(uri: string): string | null {
  const idx = uri.indexOf('://');
  return idx === -1 ? null : uri.slice(0, idx).toLowerCase();
}

/** Append chain=🔀 中转代理 to query params (before #fragment if present). */
function addChain(uri: string): string {
  const hashIdx = uri.lastIndexOf('#');
  const base = hashIdx !== -1 ? uri.slice(0, hashIdx) : uri;
  const fragment = hashIdx !== -1 ? uri.slice(hashIdx) : '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}chain=${encodeURIComponent(CHAIN)}${fragment}`;
}

/** Add prefix to node name — only modifies the name, nothing else. */
function rename(uri: string, prefix: string): string {
  try {
    if (uri.startsWith('vmess://')) return renameVmess(uri, prefix);
    if (uri.startsWith('ssr://'))   return renameSSR(uri, prefix);
    return renameFragment(uri, prefix);
  } catch {
    return uri;
  }
}

function renameVmess(uri: string, prefix: string): string {
  const b64 = uri.slice('vmess://'.length);
  const json = JSON.parse(atob(b64)) as Record<string, unknown>;
  json.ps = prefix + String(json.ps || json.add || '');
  return 'vmess://' + btoa(JSON.stringify(json));
}

function renameSSR(uri: string, prefix: string): string {
  const b64 = uri.slice('ssr://'.length);
  const decoded = safeAtob(b64);
  const sepIdx = decoded.indexOf('/?');
  if (sepIdx === -1) return uri;
  const main = decoded.slice(0, sepIdx);
  const params = new URLSearchParams(decoded.slice(sepIdx + 2));
  const remarks = params.get('remarks') || '';
  let name = '';
  try { name = atob(safeB64Pad(remarks)); } catch { name = remarks; }
  params.set('remarks', safeBtoa(prefix + name));
  return 'ssr://' + safeBtoa(main + '/?' + params.toString());
}

function renameFragment(uri: string, prefix: string): string {
  // remark= query param (Shadowrocket subscription format)
  if (/[?&]remark=/.test(uri)) {
    return uri.replace(/([?&])(remark=)([^&#]*)/, (_, sep, key, val) =>
      sep + key + encodeURIComponent(prefix + decodeURIComponent(val))
    );
  }
  // Standard #fragment
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx === -1) return uri + '#' + encodeURIComponent(prefix + 'node');
  const base = uri.slice(0, hashIdx);
  const name = decodeURIComponent(uri.slice(hashIdx + 1).replace(/\+/g, '%20'));
  return base + '#' + encodeURIComponent(prefix + name);
}

function safeAtob(s: string): string {
  return atob(safeB64Pad(s.replace(/-/g, '+').replace(/_/g, '/')));
}

function safeB64Pad(s: string): string {
  return s.padEnd(Math.ceil(s.length / 4) * 4, '=');
}

function safeBtoa(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function splitSubs(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}
