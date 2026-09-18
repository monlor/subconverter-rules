# Repository Instructions

## Source of Truth

- `full.ini` is the source of truth for `ruleset=` order and `custom_proxy_group=` definitions.
- Local custom rulesets live under `rules/`.
- Configs are generated **at runtime** by the Docker service in `server/` — there are no pre-built output files to edit or commit.
- Do not commit real subscription URLs or tokens.

## Rule Changes

- To add, remove, or reorder a ruleset, edit `full.ini`.
- To modify a proxy/rule group, edit the relevant `custom_proxy_group=` line in `full.ini`.
- To change custom ruleset content, edit the matching file under `rules/`.
- Keep existing policy names, group names, and rule ordering unless the task explicitly asks for a rename or reorder.
- Prefer adding domain/IP/process rules to the appropriate `rules/` file instead of adding inline rules directly to `full.ini`, unless an explicit ordering override is required.

## Server (Docker)

`server/` is a Node.js service that generates Shadowrocket / Surge / Clash configs on demand. Rules (`full.ini`, `rules/`, vendored ACL4SSR snapshots) are baked into the image at build time. Runtime network access is only used to fetch `PROXY_SUBS` / `RELAY_SUBS`.

### Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /config?key=KEY` | required | Auto-detect client by UA; returns Shadowrocket/Surge/Clash config |
| `GET /config?key=KEY&target=surge` | required | Force a specific client (`shadowrocket`, `surge`, `clash`) |
| `GET /sub?key=KEY` | required | Shadowrocket subscription (PROXY@/DIRECT@/RELAY@ prefixed nodes) |
| `GET /ruleset/<N>?t=shadowrocket\|surge` | public | Converted ruleset for inline RULE-SET references |
| `GET /status?key=KEY` | required | Local ruleset status JSON |

Add `&force=1` to bypass the in-TTL check and refetch subscriptions. Subscription bodies (`PROXY_SUBS`/`RELAY_SUBS`) refetch after `SUB_CACHE_TTL` seconds (default 3600). Fetch failure, empty body, or a body with no proxy URIs keeps the last good copy (persisted under `CACHE_DIR`).

### User-Agent detection

| UA contains | Client |
|---|---|
| `Shadowrocket` | Shadowrocket `.conf` |
| `Surge` | Surge `.conf` |
| `clash` / `mihomo` / `stash` / `meta` | Clash/Mihomo `.yaml` |
| unknown | Shadowrocket (default) |

### Chain proxy (链式代理)

Each client uses its native mechanism:
- **Shadowrocket**: nodes get `chain=🔀 中转代理` URI param; relay nodes get `RELAY@` prefix and feed region url-test groups.
- **Surge**: landing nodes get `underlying-proxy=🔀 中转代理`. Relay nodes from `RELAY_SUBS`.
- **Clash/Mihomo**: landing nodes get `dialer-proxy: 🔀 中转代理`. Relay nodes from `RELAY_SUBS`.

### Local development

```sh
cd server
npm ci
npm run build
npm run vendor        # first time, or after external ruleset updates
PORT=3001 SECRET_KEY=test PROXY_SUBS=<订阅地址> node dist/server.js
```

`PROXY_SUBS` is required. Multiple URLs: comma or newline. `SUB_CACHE_TTL` (seconds, default 3600) controls refetch; `force=1` refetches immediately. Last good body is kept on disk.

Run tests:

```sh
cd server && npm test
```

### Docker

```sh
export SECRET_KEY='请替换为随机密钥'
export PROXY_SUBS='https://example.com/your-subscription'
# optional: export RELAY_SUBS='https://example.com/your-relay-subscription'
docker compose up -d --build
```

### Static template files

These files are read from the image at runtime and must stay in the repo:
- `shadowrocket/template.conf` — Shadowrocket `[General]`/`[Host]`/`[MITM]` template
- `surge/template.conf` — Surge static sections with placeholders

## Validation

After editing `full.ini` or templates, run the local server and:

```sh
curl 'http://127.0.0.1:3001/config?key=KEY' -H 'User-Agent: Shadowrocket'
curl 'http://127.0.0.1:3001/config?key=KEY&target=surge'
curl 'http://127.0.0.1:3001/config?key=KEY&target=clash' | python3 -c "import yaml,sys;yaml.safe_load(sys.stdin);print('YAML OK')"
```

Check that:
- SR output has `[Proxy]` empty, `🔀 中转代理` group at top of `[Proxy Group]`, RULE-SET lines point to `/ruleset/N?t=shadowrocket`.
- Surge output uses `underlying-proxy` for chain proxy, RULE-SET lines point to `/ruleset/N?t=surge`.
- Clash output has valid YAML, `dialer-proxy: "🔀 中转代理"` on landing nodes when `RELAY_SUBS` is set.
