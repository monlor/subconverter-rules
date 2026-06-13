export interface Env {
  SECRET_KEY: string;
  PROXY_SUBS: string;
  RELAY_SUBS: string;
  CACHE?: KVNamespace;
}

export const PROXYPASS_UNSUPPORTED = new Set([
  'wireguard', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'juicity', 'anytls',
]);
