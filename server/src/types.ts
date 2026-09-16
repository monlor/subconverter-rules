import { MemoryKV } from './memory-kv.js';

export interface Env {
  SECRET_KEY: string;
  // Comma-separated subscription URLs (base64 URI format)
  PROXY_SUBS: string;   // landing proxies (PROXY@/DIRECT@ in SR sub)
  RELAY_SUBS: string;   // relay/chain proxies (RELAY@ in SR sub)
  // Optional Surge egress interface (e.g. "en0")
  SURGE_INTERFACE?: string;
  // Seconds before PROXY_SUBS/RELAY_SUBS are refetched (default 3600). 0 = always refetch.
  SUB_CACHE_TTL?: string;
  CACHE: MemoryKV;
}

export type ClientTarget = 'shadowrocket' | 'surge' | 'clash';

// Protocols that don't support proxy-passthrough (chain param not applicable)
export const PROXYPASS_UNSUPPORTED = new Set([
  'wireguard', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'juicity', 'anytls',
]);

// Per-client supported proxy types (based on subconverter reference implementation)
// Surge: no native VLESS/TUIC/SSR support
export const SURGE_SUPPORTED_TYPES = new Set(['ss', 'vmess', 'trojan', 'hy2', 'tuic', 'anytls']);
// Clash/Mihomo: full protocol support
export const CLASH_SUPPORTED_TYPES = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hy2', 'tuic', 'anytls']);
// Shadowrocket: full protocol support
export const SHADOWROCKET_SUPPORTED_TYPES = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hy2', 'tuic', 'anytls']);

export const EXCLUDED_NODE_PATTERN = '家宽|5G网络|星链|住宅|游戏|抓包|HOME|GAME|FORWARD|实验';

export interface RuleSet {
  policy: string;
  target: string;  // [] prefix = inline rule; otherwise URL
  options: string[];
}

export interface ProxyGroup {
  name: string;
  groupType: string;
  items: string[];  // []Name = policy name; otherwise regex filter
}
