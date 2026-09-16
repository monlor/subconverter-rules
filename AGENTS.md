# Repository Instructions

## Source of Truth

- `full.ini` is the source of truth for `ruleset=` order and `custom_proxy_group=` definitions.
- Local custom rulesets live under `rules/`.
- Configs are generated **at runtime** by the `worker/` Cloudflare Worker — there are no pre-built output files to edit or commit.
- Do not commit real subscription URLs or tokens.

## Rule Changes

- To add, remove, or reorder a ruleset, edit `full.ini`.
- To modify a proxy/rule group, edit the relevant `custom_proxy_group=` line in `full.ini`.
- To change custom ruleset content, edit the matching file under `rules/`.
- Keep existing policy names, group names, and rule ordering unless the task explicitly asks for a rename or reorder.
- Prefer adding domain/IP/process rules to the appropriate `rules/` file instead of adding inline rules directly to `full.ini`, unless an explicit ordering override is required.

## Worker

The `worker/` directory is a Cloudflare Worker that serves `mysub.monlor.com`. It reads `full.ini`, `shadowrocket/lazy_group.conf`, and `surge/template.conf` from the repo at runtime and generates configs for all three clients on demand.

### Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /config?key=KEY` | required | Auto-detect client by UA; returns Shadowrocket/Surge/Clash config |
| `GET /config?key=KEY&target=surge` | required | Force a specific client (`shadowrocket`, `surge`, `clash`) |
| `GET /sub?key=KEY` | required | Shadowrocket subscription (PROXY@/DIRECT@/RELAY@ prefixed nodes) |
| `GET /ruleset/<N>?t=shadowrocket\|surge` | public | Converted ruleset for inline RULE-SET references |

Add `&force=1` to bypass KV cache. Subscription bodies (`PROXY_SUBS`/`RELAY_SUBS`) refetch after `SUB_CACHE_TTL` seconds (default 3600); fetch failure keeps the last good copy.

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
- **Surge**: `代理节点 policy-path=<PROXY_SUB_URL>` with `external-policy-modifier="underlying-proxy=🔀 中转代理"`. Relay nodes from `RELAY_SUB_URL`.
- **Clash/Mihomo**: `proxy-providers.landing` with `override.dialer-proxy: 🔀 中转代理`. Relay nodes from `RELAY_SUB_URL`.

### Local development

```sh
cd worker
npm install
npx wrangler dev
```

Test all three clients:
```sh
curl 'http://127.0.0.1:8787/config?key=KEY' -H 'User-Agent: Shadowrocket' | head -30
curl 'http://127.0.0.1:8787/config?key=KEY' -H 'User-Agent: Surge'        | head -30
curl 'http://127.0.0.1:8787/config?key=KEY' -H 'User-Agent: clash.meta'   | head -30
curl 'http://127.0.0.1:8787/ruleset/1?t=shadowrocket'                      | head -10
```

### Deploy

```sh
cd worker
npx wrangler deploy
```

Set secrets before deploying:
```sh
npx wrangler secret put SECRET_KEY
npx wrangler secret put PROXY_SUBS      # comma-separated, for /sub merging
npx wrangler secret put RELAY_SUBS      # comma-separated, for /sub merging
npx wrangler secret put PROXY_SUB_URL   # single URL for Surge/Clash provider
npx wrangler secret put RELAY_SUB_URL   # single URL for Surge/Clash provider (optional)
npx wrangler secret put SURGE_INTERFACE # e.g. en0 (optional)
```

Optional `wrangler.toml [vars]`:
```
SUB_CACHE_TTL=3600   # seconds before PROXY_SUBS/RELAY_SUBS are refetched; 0 = every request
```

### Static template files

These files are fetched at runtime by the Worker and must stay in the repo:
- `shadowrocket/lazy_group.conf` — Shadowrocket `[General]`/`[Host]`/`[MITM]` template
- `surge/template.conf` — Surge static sections with `{{PROXY_SECTION}}` / `{{PROXY_GROUP_SECTION}}` / `{{RULE_SECTION}}` placeholders

## Validation

After editing `full.ini`, `shadowrocket/lazy_group.conf`, or `surge/template.conf`, test locally:

```sh
cd worker && npx wrangler dev
curl 'http://127.0.0.1:8787/config?key=KEY' -H 'User-Agent: Shadowrocket'
curl 'http://127.0.0.1:8787/config?key=KEY&target=surge'
curl 'http://127.0.0.1:8787/config?key=KEY&target=clash' | python3 -c "import yaml,sys;yaml.safe_load(sys.stdin);print('YAML OK')"
```

Check that:
- SR output has `[Proxy]` empty, `🔀 中转代理` group at top of `[Proxy Group]`, RULE-SET lines point to `/ruleset/N?t=shadowrocket`.
- Surge output uses `policy-path` + `underlying-proxy` for chain proxy, `smart` groups for url-test, RULE-SET lines point to `/ruleset/N?t=surge`.
- Clash output has valid YAML, `dialer-proxy: "🔀 中转代理"` in proxy-providers (when RELAY_SUB_URL set), `rule-providers` with upstream URLs.
