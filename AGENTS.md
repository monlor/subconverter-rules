# Repository Instructions

## Source of Truth

- `full.ini` is the source of truth for `ruleset=` order and `custom_proxy_group=` definitions.
- Local custom rulesets live under `rules/`.
- `shadowrocket/full.conf`, `shadowrocket/rules/`, `surge/full.conf`, and `surge/rules/` are generated outputs from `full.ini` and ruleset sources.
- Do not make Shadowrocket-only rule or group edits as the primary fix when the same behavior belongs in `full.ini` or `rules/`.
- Do not commit real subscription URLs or tokens. Generate private Surge configs to `surge/full.local.conf`.

## Rule Changes

- To add, remove, or reorder a ruleset, edit `full.ini`.
- To modify a proxy/rule group, edit the relevant `custom_proxy_group=` line in `full.ini`.
- To change custom ruleset content, edit the matching file under `rules/`.
- Keep existing policy names, group names, and rule ordering unless the task explicitly asks for a rename or reorder.
- Prefer adding domain/IP/process rules to the appropriate `rules/` file instead of adding inline rules directly to `full.ini`, unless an explicit ordering override is required.

## Shadowrocket Generation

- After changing `full.ini`, run:

```sh
rtk python3 scripts/generate_shadowrocket.py
```

- After changing files under `rules/`, refresh the generated Shadowrocket rulesets before finishing. Use a full refresh when rule content must be regenerated:

```sh
rtk python3 scripts/generate_shadowrocket.py --refresh-rules
```

- If network fetches fail during a full refresh, delete only the affected generated file under `shadowrocket/rules/` and rerun the normal generator so local-source rules can be rebuilt without forcing every remote ruleset.

## Surge Generation

- After changing `full.ini`, run:

```sh
rtk python3 scripts/generate_surge.py
```

- Default user-facing Surge output is `surge/full.conf`.
- Agent validation or private airport subscription tests must write to the ignored local output with `--agent-test`:

```sh
rtk python3 scripts/generate_surge.py \
  --agent-test \
  --proxy-url "$PROXY_SURGE_URL" \
  --relay-url "$RELAY_SURGE_URL" \
  --interface en0
```

- `--output` can still be used for an explicit custom path.

- The Surge generator emits shared `[General]` defaults for DNS, encrypted DNS, VIF excluded routes, LAN proxy listening ports, and GeoIP database URL.
- `--relay-url` is optional. Omit it when no relay subscription region groups should be generated.
- `--interface` is optional. When set, it injects that default egress interface into generated external subscription policies and creates the selectable `🌐 默认网卡` direct policy. When omitted, `🌐 默认网卡` and external `interface=...` modifiers are not generated.
- `📱 蜂窝流量`, `代理节点`, and `中转节点` are always generated with `hidden=true`.
- Bottom regional node groups and relay test groups are hidden by default. Use `--no-hide-node-groups` to show those generated groups. The generated hidden parameter is `hidden=true`.
- `📶 中转网卡` is always generated as a selectable group backed by `[Proxy]` direct policies for `en0` through `en10`, `utun0` through `utun5`, and `pdp_ip0`.
- `🇨🇳 中国服务` follows `full.ini` order and defaults to `DIRECT`; it does not inject cellular or relay interface policies.
- Surge `select` groups keep `DIRECT` first only when it is the default option. If `DIRECT` is present but not default, the generator moves it to the bottom.
- Common macOS interface names:
  - `en0`: usually Wi-Fi or the primary default interface.
  - `en1`/`en2`/`en3`: often Thunderbolt bridge or additional built-in/virtual Ethernet interfaces.
  - `en4` through `en10`: often USB-C Ethernet, USB tethering, or extra adapters.
  - `bridge0`: bridge interface, commonly used by virtualization or Thunderbolt bridge.
  - `awdl0`/`llw0`: Apple Wireless Direct Link interfaces, not recommended as egress.
  - `utun0` through `utun5`: VPN/tunnel interfaces, usable only when intentionally binding a tunnel.
  - `pdp_ip0`: cellular data interface on iOS and some tethering environments.
  - `lo0`: loopback, not usable as internet egress.
- Check the current Mac interfaces with:

```sh
networksetup -listallhardwareports
ifconfig
```

- After changing files under `rules/`, refresh the generated Surge rulesets when rule content must be regenerated:

```sh
rtk python3 scripts/generate_surge.py --refresh-rules
```

## Validation

- Run a quick syntax check after generator changes or when touching generated output:

```sh
rtk python3 -m py_compile scripts/generate_shadowrocket.py
rtk python3 -m py_compile scripts/generate_surge.py
```

- Verify generated output before finalizing:
  - `shadowrocket/full.conf` keeps the same enabled `ruleset=` order and policy names from `full.ini`.
  - `shadowrocket/rules/` contains converted ruleset files for all URL rulesets.
  - No incompatible rule syntax such as `DEST-PORT` remains in generated Shadowrocket rules.
  - `surge/full.conf` keeps the same enabled `ruleset=` order and policy names from `full.ini`.
  - `surge/rules/` contains converted ruleset files for all URL rulesets.
  - Surge generated rules preserve `DEST-PORT` and do not use Shadowrocket-only `DST-PORT`.
  - `git diff --check` passes.
