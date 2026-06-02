# Repository Instructions

## Source of Truth

- `full.ini` is the source of truth for `ruleset=` order and `custom_proxy_group=` definitions.
- Local custom rulesets live under `rules/`.
- `shadowrocket/full.conf` and `shadowrocket/rules/` are generated outputs from `full.ini` and ruleset sources.
- Do not make Shadowrocket-only rule or group edits as the primary fix when the same behavior belongs in `full.ini` or `rules/`.

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

## Validation

- Run a quick syntax check after generator changes or when touching generated output:

```sh
rtk python3 -m py_compile scripts/generate_shadowrocket.py
```

- Verify generated output before finalizing:
  - `shadowrocket/full.conf` keeps the same enabled `ruleset=` order and policy names from `full.ini`.
  - `shadowrocket/rules/` contains converted ruleset files for all URL rulesets.
  - No incompatible rule syntax such as `DEST-PORT` remains in generated Shadowrocket rules.
  - `git diff --check` passes.
