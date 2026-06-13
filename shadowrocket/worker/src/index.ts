import { Env } from './types.js';
import { generateSub } from './sub.js';
import { generateConfig } from './config.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (env.SECRET_KEY && key !== env.SECRET_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    const force = url.searchParams.get('force') === '1';

    if (url.pathname === '/sub')    return handleSub(env, force);
    if (url.pathname === '/config') return handleConfig(env, force);

    return new Response(HELP_TEXT, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

async function handleSub(env: Env, force: boolean): Promise<Response> {
  try {
    const sub = await generateSub(env, force);
    return new Response(sub, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Subscription-Userinfo': 'upload=0; download=0; total=107374182400; expire=99999999999',
      },
    });
  } catch (e) {
    return new Response(`Error: ${String(e)}`, { status: 500 });
  }
}

async function handleConfig(env: Env, force: boolean): Promise<Response> {
  try {
    const config = await generateConfig(env, force);
    return new Response(config, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="shadowrocket.conf"',
      },
    });
  } catch (e) {
    return new Response(`Error: ${String(e)}`, { status: 500 });
  }
}

const HELP_TEXT = `Shadowrocket Worker

Endpoints:
  GET /sub?key=<KEY>           — SS subscription (proxy nodes with PROXY@/DIRECT@/RELAY@ prefix)
  GET /config?key=<KEY>        — Shadowrocket .conf (routing rules, no embedded nodes)
  Add &force=1 to bypass cache
`;
