import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleRequest } from './router.js';
import { MemoryKV } from './memory-kv.js';
import { Env } from './types.js';

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }

  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
  });
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  res.end(body);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const proxySubs = source.PROXY_SUBS?.trim();
  if (!proxySubs) throw new Error('PROXY_SUBS is required');

  const cacheDir = source.CACHE_DIR?.trim() || resolve('data/cache');

  return {
    SECRET_KEY: source.SECRET_KEY ?? '',
    PROXY_SUBS: proxySubs,
    RELAY_SUBS: source.RELAY_SUBS?.trim() ?? '',
    SURGE_INTERFACE: source.SURGE_INTERFACE,
    SUB_CACHE_TTL: source.SUB_CACHE_TTL?.trim() || undefined,
    CACHE: new MemoryKV(cacheDir),
  };
}

export function createSubhubServer(env: Env) {
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method Not Allowed');
      return;
    }

    handleRequest(toWebRequest(req), env)
      .then(response => writeWebResponse(response, res))
      .catch(err => {
        res.statusCode = 500;
        res.end(`Internal error: ${String(err)}`);
      });
  });
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  const port = parsePort(process.env.PORT);
  createSubhubServer(loadEnv()).listen(port, () => {
    console.log(`subhub server listening on :${port}`);
  });
}
