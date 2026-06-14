export interface Env {
  SECRET_KEY: string;
  // Comma-separated subscription URLs (base64 URI format)
  PROXY_SUBS: string;   // landing proxies (PROXY@/DIRECT@ in SR sub)
  RELAY_SUBS: string;   // relay/chain proxies (RELAY@ in SR sub)
  // Base URL for fetching repo files at runtime
  REPO_BASE_URL?: string;
  // Optional Surge egress interface (e.g. "en0")
  SURGE_INTERFACE?: string;
  CACHE?: KVNamespace;
}

export type ClientTarget = 'shadowrocket' | 'surge' | 'clash';

// Protocols that don't support proxy-passthrough (chain param not applicable)
export const PROXYPASS_UNSUPPORTED = new Set([
  'wireguard', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'juicity', 'anytls',
]);

export const EXCLUDED_NODE_PATTERN = '家宽|5G网络|星链|住宅|游戏|抓包|HOME|GAME|FORWARD|实验';

export const DEFAULT_REPO_BASE_URL =
  'https://raw.githubusercontent.com/monlor/subconverter-rules/main/';

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
