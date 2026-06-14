/**
 * Proxy URI parser and format converter.
 * Supports: ss, ssr, vmess, vless, trojan, hysteria2 (hy2), tuic
 */
import { SURGE_SUPPORTED_TYPES } from './types.js';

export interface ParsedProxy {
  name: string;
  type: string;
  server: string;
  port: number;

  // Credentials
  password?: string;
  uuid?: string;

  // SS
  cipher?: string;

  // SS plugin / obfs
  plugin?: string;        // obfs, v2ray-plugin
  pluginMode?: string;    // http, tls, websocket
  pluginHost?: string;
  pluginPath?: string;

  // VMess
  alterId?: number;

  // Transport
  network?: string;       // tcp, ws, h2, grpc, http
  wsPath?: string;
  wsHost?: string;
  grpcService?: string;
  httpPath?: string;
  httpHost?: string;

  // TLS
  tls?: boolean;
  sni?: string;
  fingerprint?: string;
  skipCertVerify?: boolean;
  alpn?: string[];

  // VLESS
  flow?: string;
  realityPbk?: string;
  realitySid?: string;

  // Hysteria2
  authStr?: string;
  obfs?: string;
  obfsPassword?: string;
  uploadBw?: number;
  downloadBw?: number;

  // TUIC
  congestionControl?: string;

  // UDP
  udp?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeAtob(s: string): string {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return atob(padded);
}

function decodeName(raw: string): string {
  try { return decodeURIComponent(raw.replace(/\+/g, '%20')); } catch { return raw; }
}

function parsePort(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 443 : n;
}

function boolParam(v: string | null | undefined): boolean | undefined {
  if (v == null) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

// ─── SS parser ───────────────────────────────────────────────────────────────
// Formats: ss://BASE64(method:password)@host:port[/?plugin=...][#name]
//          ss://BASE64(method:password@host:port)[#name]   (legacy)

export function parseSSUri(uri: string): ParsedProxy | null {
  try {
    const withoutScheme = uri.slice('ss://'.length);
    const hashIdx = withoutScheme.indexOf('#');
    const name = hashIdx !== -1 ? decodeName(withoutScheme.slice(hashIdx + 1)) : 'SS Node';
    const main = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

    const atIdx = main.lastIndexOf('@');
    let method: string, password: string, server: string, portStr: string, queryStr = '';

    if (atIdx !== -1) {
      // SIP002: userinfo@host:port[/?plugin=...]
      const userinfo = main.slice(0, atIdx);
      let hostpart = main.slice(atIdx + 1);
      const qIdx = hostpart.indexOf('?');
      if (qIdx !== -1) { queryStr = hostpart.slice(qIdx + 1); hostpart = hostpart.slice(0, qIdx); }
      const slashIdx = hostpart.indexOf('/');
      if (slashIdx !== -1) hostpart = hostpart.slice(0, slashIdx);

      // userinfo may be base64 or plain method:pass
      let decoded = userinfo;
      try { decoded = safeAtob(userinfo); } catch {}
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) return null;
      method = decoded.slice(0, colonIdx);
      password = decoded.slice(colonIdx + 1);

      const lastColon = hostpart.lastIndexOf(':');
      if (lastColon === -1) return null;
      server = hostpart.slice(0, lastColon);
      portStr = hostpart.slice(lastColon + 1);
    } else {
      // Legacy: BASE64(method:password@host:port)
      const decoded = safeAtob(main.split('/')[0]);
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) return null;
      method = decoded.slice(0, colonIdx);
      const rest = decoded.slice(colonIdx + 1);
      const atIdx2 = rest.lastIndexOf('@');
      if (atIdx2 === -1) return null;
      password = rest.slice(0, atIdx2);
      const hostpart = rest.slice(atIdx2 + 1);
      const lastColon = hostpart.lastIndexOf(':');
      if (lastColon === -1) return null;
      server = hostpart.slice(0, lastColon);
      portStr = hostpart.slice(lastColon + 1);
    }

    const proxy: ParsedProxy = { name, type: 'ss', server, port: parsePort(portStr), cipher: method, password, udp: true };

    if (queryStr) {
      const params = new URLSearchParams(queryStr);
      const pluginRaw = params.get('plugin') ?? '';
      if (pluginRaw.includes('obfs')) {
        const pluginParts = pluginRaw.split(';');
        proxy.plugin = 'obfs';
        for (const p of pluginParts.slice(1)) {
          const [k, v] = p.split('=');
          if (k === 'obfs') proxy.pluginMode = v;
          if (k === 'obfs-host') proxy.pluginHost = v;
          if (k === 'obfs-uri') proxy.pluginPath = v;
        }
      }
    }

    return proxy;
  } catch { return null; }
}

// ─── SSR parser ──────────────────────────────────────────────────────────────
// ssr://BASE64(host:port:protocol:method:obfs:BASE64(password)/?params)

export function parseSSRUri(uri: string): ParsedProxy | null {
  try {
    const decoded = safeAtob(uri.slice('ssr://'.length));
    const qIdx = decoded.indexOf('/?');
    const main = qIdx !== -1 ? decoded.slice(0, qIdx) : decoded;
    const queryStr = qIdx !== -1 ? decoded.slice(qIdx + 2) : '';

    const parts = main.split(':');
    if (parts.length < 6) return null;
    const [server, portStr, , method, , b64pass] = parts;
    const password = safeAtob(b64pass);

    const params = new URLSearchParams(queryStr);
    const remarks = params.get('remarks') ?? '';
    const name = remarks ? safeAtob(remarks) : `SSR-${server}`;

    return { name, type: 'ssr', server, port: parsePort(portStr), cipher: method, password, udp: true };
  } catch { return null; }
}

// ─── VMess parser ────────────────────────────────────────────────────────────
// vmess://BASE64_JSON { v, ps, add, port, id, aid, scy, net, type, host, path, tls, sni, ... }

export function parseVmessUri(uri: string): ParsedProxy | null {
  try {
    const json = JSON.parse(safeAtob(uri.slice('vmess://'.length))) as Record<string, unknown>;
    const s = (k: string) => String(json[k] ?? '');
    const name = s('ps') || s('add') || 'VMess Node';
    const server = s('add');
    const port = parsePort(s('port'));
    const uuid = s('id');
    const network = s('net') || 'tcp';
    const tls = s('tls') === 'tls' || s('tls') === '1';
    const sni = s('sni') || s('host');

    const proxy: ParsedProxy = { name, type: 'vmess', server, port, uuid, alterId: Number(json.aid ?? 0), network, tls };
    if (sni) proxy.sni = sni;
    if (network === 'ws') {
      proxy.wsPath = s('path') || '/';
      proxy.wsHost = s('host');
    }
    if (network === 'grpc') proxy.grpcService = s('path');
    if (network === 'h2' || network === 'http') {
      proxy.httpPath = s('path') || '/';
      proxy.httpHost = s('host');
    }
    if (s('skip-cert-verify') === '1' || s('allowInsecure') === '1') proxy.skipCertVerify = true;
    return proxy;
  } catch { return null; }
}

// ─── VLESS parser ─────────────────────────────────────────────────────────────
// vless://uuid@host:port?security=tls&type=ws&path=/xxx&host=xxx&sni=xxx&flow=xxx#name

export function parseVlessUri(uri: string): ParsedProxy | null {
  try {
    const withoutScheme = uri.slice('vless://'.length);
    const hashIdx = withoutScheme.indexOf('#');
    const name = hashIdx !== -1 ? decodeName(withoutScheme.slice(hashIdx + 1)) : 'VLESS Node';
    const main = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

    const atIdx = main.indexOf('@');
    if (atIdx === -1) return null;
    const uuid = main.slice(0, atIdx);
    const rest = main.slice(atIdx + 1);
    const qIdx = rest.indexOf('?');
    const hostpart = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx !== -1 ? rest.slice(qIdx + 1) : '';

    const lastColon = hostpart.lastIndexOf(':');
    if (lastColon === -1) return null;
    const server = hostpart.slice(0, lastColon);
    const port = parsePort(hostpart.slice(lastColon + 1));

    const params = new URLSearchParams(queryStr);
    const security = params.get('security') ?? '';
    const tls = security === 'tls' || security === 'reality';
    const network = params.get('type') ?? 'tcp';
    const sni = params.get('sni') ?? params.get('host') ?? '';
    const flow = params.get('flow') ?? '';

    const proxy: ParsedProxy = { name, type: 'vless', server, port, uuid, tls, network };
    if (sni) proxy.sni = sni;
    if (flow) proxy.flow = flow;
    if (params.get('fp')) proxy.fingerprint = params.get('fp')!;
    if (boolParam(params.get('allowInsecure'))) proxy.skipCertVerify = true;
    const pbk = params.get('pbk') ?? '';
    const sid = params.get('sid') ?? '';
    if (pbk) proxy.realityPbk = pbk;
    if (sid) proxy.realitySid = sid;
    if (network === 'ws') {
      proxy.wsPath = params.get('path') ?? '/';
      proxy.wsHost = params.get('host') ?? '';
    }
    if (network === 'grpc') proxy.grpcService = params.get('serviceName') ?? '';
    return proxy;
  } catch { return null; }
}

// ─── Trojan parser ────────────────────────────────────────────────────────────
// trojan://password@host:port?sni=xxx&type=ws&path=/xxx#name

export function parseTrojanUri(uri: string): ParsedProxy | null {
  try {
    const withoutScheme = uri.slice('trojan://'.length);
    const hashIdx = withoutScheme.indexOf('#');
    const name = hashIdx !== -1 ? decodeName(withoutScheme.slice(hashIdx + 1)) : 'Trojan Node';
    const main = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

    const atIdx = main.indexOf('@');
    if (atIdx === -1) return null;
    const password = main.slice(0, atIdx);
    const rest = main.slice(atIdx + 1);
    const qIdx = rest.indexOf('?');
    const hostpart = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx !== -1 ? rest.slice(qIdx + 1) : '';

    const lastColon = hostpart.lastIndexOf(':');
    if (lastColon === -1) return null;
    const server = hostpart.slice(0, lastColon);
    const port = parsePort(hostpart.slice(lastColon + 1));

    const params = new URLSearchParams(queryStr);
    const sni = params.get('sni') ?? params.get('peer') ?? '';
    const network = params.get('type') ?? 'tcp';

    const proxy: ParsedProxy = { name, type: 'trojan', server, port, password, tls: true, network };
    if (sni) proxy.sni = sni;
    if (boolParam(params.get('allowInsecure'))) proxy.skipCertVerify = true;
    if (network === 'ws') {
      proxy.wsPath = params.get('path') ?? '/';
      proxy.wsHost = params.get('host') ?? '';
    }
    if (network === 'grpc') proxy.grpcService = params.get('serviceName') ?? '';
    return proxy;
  } catch { return null; }
}

// ─── Hysteria2 parser ─────────────────────────────────────────────────────────
// hy2://auth@host:port?sni=xxx&obfs=salamander&obfs-password=xxx#name

export function parseHysteria2Uri(uri: string): ParsedProxy | null {
  try {
    const scheme = uri.startsWith('hysteria2://') ? 'hysteria2://' : 'hy2://';
    const withoutScheme = uri.slice(scheme.length);
    const hashIdx = withoutScheme.indexOf('#');
    const name = hashIdx !== -1 ? decodeName(withoutScheme.slice(hashIdx + 1)) : 'Hy2 Node';
    const main = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

    const atIdx = main.indexOf('@');
    if (atIdx === -1) return null;
    const auth = decodeURIComponent(main.slice(0, atIdx));
    const rest = main.slice(atIdx + 1);
    const qIdx = rest.indexOf('?');
    const hostpart = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx !== -1 ? rest.slice(qIdx + 1) : '';

    const lastColon = hostpart.lastIndexOf(':');
    if (lastColon === -1) return null;
    const server = hostpart.slice(0, lastColon);
    const port = parsePort(hostpart.slice(lastColon + 1));

    const params = new URLSearchParams(queryStr);
    const sni = params.get('sni') ?? '';
    const obfs = params.get('obfs') ?? '';
    const obfsPassword = params.get('obfs-password') ?? '';

    const proxy: ParsedProxy = { name, type: 'hy2', server, port, password: auth, tls: true, udp: true };
    if (sni) proxy.sni = sni;
    if (obfs) proxy.obfs = obfs;
    if (obfsPassword) proxy.obfsPassword = obfsPassword;
    if (boolParam(params.get('insecure'))) proxy.skipCertVerify = true;
    return proxy;
  } catch { return null; }
}

// ─── TUIC v5 parser ───────────────────────────────────────────────────────────
// tuic://uuid:password@host:port?sni=xxx&alpn=h3&congestion_control=bbr#name

export function parseTuicUri(uri: string): ParsedProxy | null {
  try {
    const withoutScheme = uri.slice('tuic://'.length);
    const hashIdx = withoutScheme.indexOf('#');
    const name = hashIdx !== -1 ? decodeName(withoutScheme.slice(hashIdx + 1)) : 'TUIC Node';
    const main = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

    const atIdx = main.indexOf('@');
    if (atIdx === -1) return null;
    const userinfo = main.slice(0, atIdx);
    const rest = main.slice(atIdx + 1);

    const colonIdx = userinfo.indexOf(':');
    const uuid = colonIdx !== -1 ? userinfo.slice(0, colonIdx) : userinfo;
    const password = colonIdx !== -1 ? userinfo.slice(colonIdx + 1) : '';

    const qIdx = rest.indexOf('?');
    const hostpart = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx !== -1 ? rest.slice(qIdx + 1) : '';

    const lastColon = hostpart.lastIndexOf(':');
    if (lastColon === -1) return null;
    const server = hostpart.slice(0, lastColon);
    const port = parsePort(hostpart.slice(lastColon + 1));

    const params = new URLSearchParams(queryStr);
    const sni = params.get('sni') ?? '';
    const alpnRaw = params.get('alpn') ?? 'h3';
    const congestion = params.get('congestion_control') ?? params.get('congestion') ?? 'bbr';

    const proxy: ParsedProxy = { name, type: 'tuic', server, port, uuid, password, tls: true, udp: true };
    if (sni) proxy.sni = sni;
    proxy.alpn = alpnRaw.split(',').map(s => s.trim()).filter(Boolean);
    proxy.congestionControl = congestion;
    if (boolParam(params.get('allowInsecure'))) proxy.skipCertVerify = true;
    return proxy;
  } catch { return null; }
}

// ─── AnyTLS parser ───────────────────────────────────────────────────────────
// anytls://password@host:port?sni=xxx&insecure=1&fingerprint=xxx#name

export function parseAnyTLSUri(uri: string): ParsedProxy | null {
  try {
    const withoutScheme = uri.slice('anytls://'.length);
    const hashIdx = withoutScheme.indexOf('#');
    const name = hashIdx !== -1 ? decodeName(withoutScheme.slice(hashIdx + 1)) : 'AnyTLS Node';
    const main = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

    const atIdx = main.indexOf('@');
    if (atIdx === -1) return null;
    const password = decodeURIComponent(main.slice(0, atIdx));
    const rest = main.slice(atIdx + 1);
    const qIdx = rest.indexOf('?');
    const hostpart = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx !== -1 ? rest.slice(qIdx + 1) : '';

    const lastColon = hostpart.lastIndexOf(':');
    if (lastColon === -1) return null;
    const server = hostpart.slice(0, lastColon);
    const port = parsePort(hostpart.slice(lastColon + 1));

    const params = new URLSearchParams(queryStr);
    const sni = params.get('sni') ?? '';
    const fingerprint = params.get('fingerprint') ?? '';

    const proxy: ParsedProxy = { name, type: 'anytls', server, port, password, tls: true };
    if (sni) proxy.sni = sni;
    if (fingerprint) proxy.fingerprint = fingerprint;
    if (boolParam(params.get('insecure')) || boolParam(params.get('allowInsecure'))) proxy.skipCertVerify = true;
    return proxy;
  } catch { return null; }
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export function parseProxyUri(uri: string): ParsedProxy | null {
  const trimmed = uri.trim();
  if (trimmed.startsWith('ss://')) return parseSSUri(trimmed);
  if (trimmed.startsWith('ssr://')) return parseSSRUri(trimmed);
  if (trimmed.startsWith('vmess://')) return parseVmessUri(trimmed);
  if (trimmed.startsWith('vless://')) return parseVlessUri(trimmed);
  if (trimmed.startsWith('trojan://')) return parseTrojanUri(trimmed);
  if (trimmed.startsWith('hy2://') || trimmed.startsWith('hysteria2://')) return parseHysteria2Uri(trimmed);
  if (trimmed.startsWith('tuic://')) return parseTuicUri(trimmed);
  if (trimmed.startsWith('anytls://')) return parseAnyTLSUri(trimmed);
  return null;
}

export function parseProxiesFromSubscription(content: string): ParsedProxy[] {
  const results: ParsedProxy[] = [];
  for (const line of content.split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t.includes('://')) continue;
    const p = parseProxyUri(t);
    if (p) results.push(p);
  }
  return results;
}

// ─── Surge format ─────────────────────────────────────────────────────────────

export function toSurgeLine(proxy: ParsedProxy, underlyingProxy?: string): string | null {
  if (!SURGE_SUPPORTED_TYPES.has(proxy.type)) return null;
  const chain = underlyingProxy ? `, underlying-proxy=${underlyingProxy}` : '';
  const udp = proxy.udp !== false ? ', udp-relay=true' : '';

  switch (proxy.type) {
    case 'ss': {
      const base = `${proxy.name} = ss, ${proxy.server}, ${proxy.port}, encrypt-method=${proxy.cipher}, password=${proxy.password}${udp}`;
      if (proxy.plugin === 'obfs') {
        const mode = proxy.pluginMode ?? 'http';
        const host = proxy.pluginHost ? `, obfs-host=${proxy.pluginHost}` : '';
        const path = proxy.pluginPath ? `, obfs-uri=${proxy.pluginPath}` : '';
        return base + `, obfs=${mode}${host}${path}${chain}`;
      }
      return base + chain;
    }

    case 'ssr':
      return `${proxy.name} = ss, ${proxy.server}, ${proxy.port}, encrypt-method=${proxy.cipher}, password=${proxy.password}${udp}${chain}`;

    case 'vmess': {
      let line = `${proxy.name} = vmess, ${proxy.server}, ${proxy.port}, username=${proxy.uuid}`;
      if (proxy.tls) line += ', tls=true';
      if (proxy.sni) line += `, sni=${proxy.sni}`;
      if (proxy.skipCertVerify) line += ', skip-cert-verify=true';
      if (proxy.network === 'ws') {
        line += ', ws=true';
        if (proxy.wsPath) line += `, ws-path=${proxy.wsPath}`;
        if (proxy.wsHost) line += `, ws-headers=Host:${proxy.wsHost}`;
      }
      if (proxy.network === 'h2' || proxy.network === 'http') {
        line += ', h2=true';
        if (proxy.httpPath) line += `, h2-path=${proxy.httpPath}`;
        if (proxy.httpHost) line += `, h2-host=${proxy.httpHost}`;
      }
      return line + chain;
    }

    case 'vless': {
      let line = `${proxy.name} = vless, ${proxy.server}, ${proxy.port}, username=${proxy.uuid}`;
      if (proxy.tls) line += ', tls=true';
      if (proxy.sni) line += `, sni=${proxy.sni}`;
      if (proxy.skipCertVerify) line += ', skip-cert-verify=true';
      if (proxy.network === 'ws') {
        line += ', ws=true';
        if (proxy.wsPath) line += `, ws-path=${proxy.wsPath}`;
        if (proxy.wsHost) line += `, ws-headers=Host:${proxy.wsHost}`;
      }
      return line + chain;
    }

    case 'trojan': {
      let line = `${proxy.name} = trojan, ${proxy.server}, ${proxy.port}, password=${proxy.password}`;
      if (proxy.sni) line += `, sni=${proxy.sni}`;
      if (proxy.skipCertVerify) line += ', skip-cert-verify=true';
      if (proxy.network === 'ws') {
        line += ', ws=true';
        if (proxy.wsPath) line += `, ws-path=${proxy.wsPath}`;
        if (proxy.wsHost) line += `, ws-headers=Host:${proxy.wsHost}`;
      }
      return line + chain;
    }

    case 'hy2': {
      let line = `${proxy.name} = hysteria2, ${proxy.server}, ${proxy.port}, password=${proxy.password}`;
      if (proxy.sni) line += `, sni=${proxy.sni}`;
      if (proxy.skipCertVerify) line += ', skip-cert-verify=true';
      if (proxy.obfs === 'salamander') line += ', obfs=salamander';
      if (proxy.obfsPassword) line += `, obfs-password=${proxy.obfsPassword}`;
      if (proxy.downloadBw) line += `, download-bandwidth=${proxy.downloadBw}`;
      return line + chain;
    }

    case 'tuic': {
      let line = `${proxy.name} = tuic-v5, ${proxy.server}, ${proxy.port}, token=${proxy.password}, uuid=${proxy.uuid}`;
      if (proxy.sni) line += `, sni=${proxy.sni}`;
      if (proxy.skipCertVerify) line += ', skip-cert-verify=true';
      if (proxy.alpn?.length) line += `, alpn=${proxy.alpn[0]}`;
      return line + chain;
    }

    case 'anytls': {
      let line = `${proxy.name} = anytls, ${proxy.server}, ${proxy.port}, password=${proxy.password}`;
      if (proxy.sni) line += `, sni=${proxy.sni}`;
      if (proxy.skipCertVerify) line += ', skip-cert-verify=true';
      if (proxy.fingerprint) line += `, server-cert-fingerprint-sha256=${proxy.fingerprint}`;
      return line + chain;
    }

    default:
      return null;
  }
}

// ─── Clash YAML format ───────────────────────────────────────────────────────

function yamlStr(s: string): string {
  return JSON.stringify(s);
}

function clashProxyLines(proxy: ParsedProxy, dialerProxy?: string): string[] | null {
  const lines: string[] = [];
  const push = (k: string, v: string) => lines.push(`    ${k}: ${v}`);

  switch (proxy.type) {
    case 'ss': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'ss');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('cipher', yamlStr(proxy.cipher ?? 'aes-256-gcm'));
      push('password', yamlStr(proxy.password ?? ''));
      push('udp', 'true');
      if (proxy.plugin === 'obfs') {
        push('plugin', 'obfs');
        const opts = [`  mode: ${proxy.pluginMode ?? 'http'}`];
        if (proxy.pluginHost) opts.push(`  host: ${yamlStr(proxy.pluginHost)}`);
        lines.push(`    plugin-opts:`);
        for (const o of opts) lines.push(`      ${o.trim().split(':')[0]}: ${o.trim().split(':').slice(1).join(':').trim()}`);
      }
      break;
    }

    case 'ssr': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'ssr');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('cipher', yamlStr(proxy.cipher ?? 'aes-256-cfb'));
      push('password', yamlStr(proxy.password ?? ''));
      push('protocol', 'origin');
      push('obfs', 'plain');
      push('udp', 'true');
      break;
    }

    case 'vmess': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'vmess');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('uuid', yamlStr(proxy.uuid ?? ''));
      push('alterId', String(proxy.alterId ?? 0));
      push('cipher', 'auto');
      if (proxy.tls) push('tls', 'true');
      if (proxy.sni) push('servername', yamlStr(proxy.sni));
      if (proxy.skipCertVerify) push('skip-cert-verify', 'true');
      if (proxy.network && proxy.network !== 'tcp') {
        push('network', proxy.network === 'h2' ? 'h2' : proxy.network);
        if (proxy.network === 'ws') {
          lines.push('    ws-opts:');
          lines.push(`      path: ${yamlStr(proxy.wsPath ?? '/')}`);
          if (proxy.wsHost) lines.push(`      headers:\n        Host: ${yamlStr(proxy.wsHost)}`);
        }
        if (proxy.network === 'grpc' && proxy.grpcService) {
          lines.push('    grpc-opts:');
          lines.push(`      grpc-service-name: ${yamlStr(proxy.grpcService)}`);
        }
        if (proxy.network === 'h2' || proxy.network === 'http') {
          lines.push('    h2-opts:');
          lines.push(`      path:\n        - ${yamlStr(proxy.httpPath ?? '/')}`);
          if (proxy.httpHost) lines.push(`      host:\n        - ${yamlStr(proxy.httpHost)}`);
        }
      }
      break;
    }

    case 'vless': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'vless');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('uuid', yamlStr(proxy.uuid ?? ''));
      if (proxy.tls) push('tls', 'true');
      if (proxy.sni) push('servername', yamlStr(proxy.sni));
      if (proxy.flow) push('flow', yamlStr(proxy.flow));
      if (proxy.skipCertVerify) push('skip-cert-verify', 'true');
      if (proxy.fingerprint) push('client-fingerprint', yamlStr(proxy.fingerprint));
      if (proxy.realityPbk) {
        lines.push('    reality-opts:');
        lines.push(`      public-key: ${yamlStr(proxy.realityPbk)}`);
        if (proxy.realitySid) lines.push(`      short-id: ${yamlStr(proxy.realitySid)}`);
      }
      if (proxy.network && proxy.network !== 'tcp') {
        push('network', proxy.network);
        if (proxy.network === 'ws') {
          lines.push('    ws-opts:');
          lines.push(`      path: ${yamlStr(proxy.wsPath ?? '/')}`);
          if (proxy.wsHost) lines.push(`      headers:\n        Host: ${yamlStr(proxy.wsHost)}`);
        }
        if (proxy.network === 'grpc' && proxy.grpcService) {
          lines.push('    grpc-opts:');
          lines.push(`      grpc-service-name: ${yamlStr(proxy.grpcService)}`);
        }
      }
      break;
    }

    case 'trojan': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'trojan');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('password', yamlStr(proxy.password ?? ''));
      if (proxy.sni) push('sni', yamlStr(proxy.sni));
      if (proxy.skipCertVerify) push('skip-cert-verify', 'true');
      if (proxy.network && proxy.network !== 'tcp') {
        push('network', proxy.network);
        if (proxy.network === 'ws') {
          lines.push('    ws-opts:');
          lines.push(`      path: ${yamlStr(proxy.wsPath ?? '/')}`);
          if (proxy.wsHost) lines.push(`      headers:\n        Host: ${yamlStr(proxy.wsHost)}`);
        }
        if (proxy.network === 'grpc' && proxy.grpcService) {
          lines.push('    grpc-opts:');
          lines.push(`      grpc-service-name: ${yamlStr(proxy.grpcService)}`);
        }
      }
      break;
    }

    case 'hy2': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'hysteria2');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('password', yamlStr(proxy.password ?? ''));
      if (proxy.sni) push('sni', yamlStr(proxy.sni));
      if (proxy.skipCertVerify) push('skip-cert-verify', 'true');
      if (proxy.obfs) {
        push('obfs', proxy.obfs);
        if (proxy.obfsPassword) push('obfs-password', yamlStr(proxy.obfsPassword));
      }
      break;
    }

    case 'tuic': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'tuic');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('uuid', yamlStr(proxy.uuid ?? ''));
      push('password', yamlStr(proxy.password ?? ''));
      if (proxy.sni) push('sni', yamlStr(proxy.sni));
      if (proxy.skipCertVerify) push('skip-cert-verify', 'true');
      if (proxy.alpn?.length) {
        lines.push('    alpn:');
        for (const a of proxy.alpn) lines.push(`      - ${a}`);
      }
      if (proxy.congestionControl) push('congestion-controller', proxy.congestionControl);
      push('udp-relay-mode', 'native');
      break;
    }

    case 'anytls': {
      lines.push(`  - name: ${yamlStr(proxy.name)}`);
      push('type', 'anytls');
      push('server', yamlStr(proxy.server));
      push('port', String(proxy.port));
      push('password', yamlStr(proxy.password ?? ''));
      if (proxy.sni) push('sni', yamlStr(proxy.sni));
      if (proxy.skipCertVerify) push('skip-cert-verify', 'true');
      if (proxy.fingerprint) push('client-fingerprint', yamlStr(proxy.fingerprint));
      break;
    }

    default:
      return null;
  }

  if (dialerProxy) push('dialer-proxy', yamlStr(dialerProxy));
  return lines;
}

export function toClashProxyYaml(proxy: ParsedProxy, dialerProxy?: string): string | null {
  const lines = clashProxyLines(proxy, dialerProxy);
  return lines ? lines.join('\n') : null;
}
