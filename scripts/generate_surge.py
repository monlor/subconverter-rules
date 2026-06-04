#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import time
from dataclasses import dataclass
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
FULL_INI = ROOT / "full.ini"
DEFAULT_OUTPUT = ROOT / "surge" / "full.conf"
AGENT_TEST_OUTPUT = ROOT / "surge" / "full.local.conf"
RULES_OUTPUT_DIR = ROOT / "surge" / "rules"
SURGE_TEMPLATE = ROOT / "surge" / "template.conf"
RAW_REPO_URL = "https://raw.githubusercontent.com/monlor/subconverter-rules/main/"
GH_PROXY_RAW_REPO_URL = "https://gh.monlor.com/" + RAW_REPO_URL
SURGE_RULES_URL = GH_PROXY_RAW_REPO_URL + "surge/rules/"
PROXY_URL_PLACEHOLDER = "https://example.invalid/PROXY_SURGE_URL"
LANDING_PROVIDER_GROUP = "代理节点"
RELAY_PROVIDER_GROUP = "中转节点"
DEFAULT_INTERFACE_POLICY = "🌐 默认网卡"
CELLULAR_POLICY_GROUP = "📱 蜂窝流量"
RELAY_INTERFACE_POLICY = "↔️ 中转网卡"
FULL_NODE_SELECT_GROUPS = {"🚀 手动选择", "📶 VoWiFi"}
RELAY_INTERFACE_NAMES = (
    *(f"en{index}" for index in range(11)),
    *(f"utun{index}" for index in range(6)),
    "pdp_ip0",
)
EXCLUDED_NODE_PATTERN = "家宽|5G网络|星链|住宅|游戏|抓包|HOME|GAME|FORWARD|实验"
MAC_INTERFACE_NOTES = (
    "# Common macOS interfaces:",
    "# en0: usually Wi-Fi or the primary default interface",
    "# en1/en2/en3: often Thunderbolt bridge or additional built-in/virtual Ethernet interfaces",
    "# en4/en5/en6/en7/en8/en9/en10: often USB-C Ethernet, USB tethering, or extra adapters",
    "# bridge0: bridge interface, commonly used by virtualization or Thunderbolt bridge",
    "# awdl0/llw0: Apple Wireless Direct Link interfaces, not recommended as egress",
    "# utun0/utun1/...: VPN/tunnel interfaces, usable only when you intentionally bind a tunnel",
    "# pdp_ip0: cellular data interface on iOS and some tethering environments",
    "# lo0: loopback, not usable as internet egress",
)
PROXY_SECTION_PLACEHOLDER = "{{PROXY_SECTION}}"
PROXY_GROUP_SECTION_PLACEHOLDER = "{{PROXY_GROUP_SECTION}}"
RULE_SECTION_PLACEHOLDER = "{{RULE_SECTION}}"

RULE_TYPE_ALIASES = {
    "DST-PORT": "DEST-PORT",
    "SRC-IP-CIDR": "SRC-IP",
}

SUPPORTED_RULE_TYPES = {
    "AND",
    "DOMAIN",
    "DOMAIN-KEYWORD",
    "DOMAIN-SET",
    "DOMAIN-SUFFIX",
    "DOMAIN-WILDCARD",
    "DEST-PORT",
    "GEOIP",
    "IN-PORT",
    "IP-ASN",
    "IP-CIDR",
    "IP-CIDR6",
    "NOT",
    "OR",
    "PROCESS-NAME",
    "PROTOCOL",
    "RULE-SET",
    "SCRIPT",
    "SRC-IP",
    "SRC-PORT",
    "USER-AGENT",
    "URL-REGEX",
}


@dataclass(frozen=True)
class RuleSet:
    policy: str
    target: str
    options: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProxyGroup:
    name: str
    group_type: str
    items: tuple[str, ...]


@dataclass(frozen=True)
class ConvertedRuleSet:
    ruleset: RuleSet
    target: str


def parse_full_ini() -> list[RuleSet]:
    rulesets: list[RuleSet] = []
    for raw_line in FULL_INI.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith((";", "#")):
            continue
        if not line.startswith("ruleset="):
            continue

        payload = line.removeprefix("ruleset=")
        parts = [part.strip() for part in payload.split(",") if part.strip()]
        if len(parts) < 2:
            continue
        target = parts[1]
        options = tuple(parts[2:])
        if target.startswith("[]"):
            target = ",".join(parts[1:])
            options = ()
        rulesets.append(RuleSet(policy=parts[0], target=target, options=options))
    return rulesets


def parse_proxy_groups() -> list[ProxyGroup]:
    groups: list[ProxyGroup] = []
    for raw_line in FULL_INI.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith((";", "#")):
            continue
        if not line.startswith("custom_proxy_group="):
            continue

        payload = line.removeprefix("custom_proxy_group=")
        parts = tuple(part.strip() for part in payload.split("`"))
        if len(parts) < 2:
            continue
        groups.append(ProxyGroup(name=parts[0], group_type=parts[1], items=parts[2:]))
    return groups


def source_path_for_url(url: str) -> Path | None:
    normalized_url = url.removeprefix("https://gh.monlor.com/")
    for prefix in (RAW_REPO_URL, GH_PROXY_RAW_REPO_URL):
        if normalized_url.startswith(prefix):
            relative = normalized_url.removeprefix(prefix)
            path = ROOT / relative
            if path.is_file():
                return path
    return None


def fetch_ruleset(url: str) -> str:
    local_path = source_path_for_url(url)
    if local_path:
        return local_path.read_text(encoding="utf-8")

    candidate_urls = [url.removeprefix("https://gh.monlor.com/")]
    if candidate_urls[0] != url:
        candidate_urls.append(url)

    last_error: Exception | None = None
    for fetch_url in candidate_urls:
        for attempt in range(3):
            request = Request(
                fetch_url, headers={"User-Agent": "subconverter-rules-surge-generator"}
            )
            try:
                with urlopen(request, timeout=30) as response:
                    return response.read().decode("utf-8")
            except (OSError, IncompleteRead) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(1)

    if last_error:
        raise URLError(last_error)
    raise URLError(f"failed to fetch {url}")


def ruleset_filename(url: str, index: int) -> str:
    normalized_url = url.removeprefix("https://gh.monlor.com/")
    if normalized_url.startswith(RAW_REPO_URL):
        relative = normalized_url.removeprefix(RAW_REPO_URL)
        stem = Path(relative.removeprefix("rules/")).name
    else:
        stem = Path(normalized_url).name
    filename = re.sub(r"[^0-9A-Za-z._-]+", "_", stem).strip("._-").lower()
    if not filename:
        filename = f"ruleset_{index}"
    if not filename.endswith((".list", ".ini", ".conf", ".txt")):
        filename += ".list"
    return f"{index:02d}_{filename}"


def clean_yaml_rule_line(line: str) -> str:
    stripped = line.strip()
    if stripped.startswith("- "):
        stripped = stripped[2:].strip()
    if stripped[:1] in {"'", '"'} and stripped[-1:] == stripped[:1]:
        stripped = stripped[1:-1].strip()
    return stripped


def convert_ruleset_line(raw_line: str) -> str | None:
    line = clean_yaml_rule_line(raw_line)
    if not line or line.startswith(("#", ";")):
        return line if line.startswith("#") else None
    if line in {"payload:", "rules:"}:
        return None

    parts = [part.strip() for part in line.split(",")]
    if not parts:
        return None

    rule_type = RULE_TYPE_ALIASES.get(parts[0].upper(), parts[0].upper())
    if rule_type not in SUPPORTED_RULE_TYPES:
        return line

    converted_parts = [rule_type, *parts[1:]]
    return ",".join(converted_parts)


def convert_ruleset_content(content: str) -> str:
    lines: list[str] = []
    for raw_line in content.splitlines():
        converted = convert_ruleset_line(raw_line)
        if converted is not None:
            lines.append(converted)
    return "\n".join(lines).rstrip() + "\n"


def write_converted_rulesets(
    rulesets: list[RuleSet], refresh_rules: bool
) -> dict[RuleSet, ConvertedRuleSet]:
    RULES_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if refresh_rules:
        for path in RULES_OUTPUT_DIR.iterdir():
            if path.is_file():
                path.unlink()

    converted: dict[RuleSet, ConvertedRuleSet] = {}
    used_filenames: set[str] = set()
    url_rulesets = [
        ruleset for ruleset in rulesets if not ruleset.target.startswith("[]")
    ]

    for index, ruleset in enumerate(url_rulesets, start=1):
        filename = ruleset_filename(ruleset.target, index)
        while filename in used_filenames:
            filename = f"{index:02d}_{filename}"
        used_filenames.add(filename)

        output_path = RULES_OUTPUT_DIR / filename
        if refresh_rules or not output_path.exists():
            try:
                source = fetch_ruleset(ruleset.target)
            except URLError as exc:
                raise RuntimeError(
                    f"failed to fetch ruleset: {ruleset.target}"
                ) from exc
            output_path.write_text(convert_ruleset_content(source), encoding="utf-8")

        converted[ruleset] = ConvertedRuleSet(
            ruleset=ruleset,
            target=SURGE_RULES_URL + filename,
        )

    return converted


def quote_param(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def convert_group_item(item: str) -> str | None:
    if not item:
        return None
    if item.startswith("[]"):
        return item.removeprefix("[]")
    return item


def parsed_group_items(group: ProxyGroup) -> tuple[list[str], list[str]]:
    policies: list[str] = []
    regex_filters: list[str] = []
    for item in group.items:
        converted = convert_group_item(item)
        if not converted:
            continue
        if item.startswith("[]"):
            policies.append(converted)
        else:
            regex_filters.append(converted)
    return policies, regex_filters


def move_non_default_direct_to_bottom(policies: list[str]) -> list[str]:
    if not policies or policies[0] == "DIRECT" or "DIRECT" not in policies:
        return policies
    return [policy for policy in policies if policy != "DIRECT"] + ["DIRECT"]


def parse_test_options(group: ProxyGroup) -> tuple[str, str, str]:
    url = (
        group.items[1]
        if len(group.items) > 1
        else "http://www.gstatic.com/generate_204"
    )
    interval = "300"
    tolerance = ""
    if len(group.items) > 2:
        test_parts = [part.strip() for part in group.items[2].split(",")]
        if len(test_parts) > 0 and test_parts[0]:
            interval = test_parts[0]
        if len(test_parts) > 2 and test_parts[2]:
            tolerance = test_parts[2]
    return url, interval, tolerance


def convert_select_proxy_group(
    group: ProxyGroup,
    relay_url: str | None,
    hide_node_groups: bool,
) -> str:
    policies, regex_filters = parsed_group_items(group)
    policies = move_non_default_direct_to_bottom(policies)
    fields = [group.group_type]
    fields.extend(policies)
    should_include_filtered_nodes = (
        bool(regex_filters)
        and group.name != "🚀 默认节点"
        and (not policies or group.name in FULL_NODE_SELECT_GROUPS)
    )
    if should_include_filtered_nodes:
        included_groups = [LANDING_PROVIDER_GROUP]
        if relay_url and group.name in FULL_NODE_SELECT_GROUPS:
            included_groups.append(RELAY_PROVIDER_GROUP)
        if len(included_groups) == 1:
            fields.append(f"include-other-group={included_groups[0]}")
        else:
            fields.append(
                f"include-other-group={quote_param(','.join(included_groups))}"
            )
        for regex_filter in regex_filters:
            fields.append(f"policy-regex-filter={quote_param(regex_filter)}")
    if should_hide_node_group(group.name, hide_node_groups):
        fields.extend(maybe_hidden(hide_node_groups))
    return f"{group.name} = {','.join(fields)}"


def convert_external_proxy_group(group: ProxyGroup, hide_node_groups: bool) -> str:
    regex = group.items[0] if len(group.items) > 0 else ""
    url, interval, tolerance = parse_test_options(group)
    is_smart_group = group.group_type == "url-test"
    fields = [
        "smart" if is_smart_group else group.group_type,
        f"include-other-group={LANDING_PROVIDER_GROUP}",
    ]
    if not is_smart_group:
        fields.extend(
            [
                f"url={url}",
                f"interval={interval}",
            ]
        )
        if tolerance:
            fields.append(f"tolerance={tolerance}")
    if regex:
        fields.append(f"policy-regex-filter={quote_param(regex)}")
    if should_hide_node_group(group.name, hide_node_groups):
        fields.extend(maybe_hidden(hide_node_groups))
    return f"{group.name} = {','.join(fields)}"


def convert_proxy_group(
    group: ProxyGroup,
    relay_url: str | None = None,
    interface_name: str | None = None,
    hide_node_groups: bool = True,
) -> str:
    if group.group_type == "select":
        return convert_select_proxy_group(group, relay_url, hide_node_groups)

    if group.group_type in {"url-test", "fallback", "load-balance", "random"}:
        return convert_external_proxy_group(group, hide_node_groups)

    fields = [group.group_type]
    for item in group.items:
        converted = convert_group_item(item)
        if converted:
            fields.append(converted)
    return f"{group.name} = {','.join(fields)}"


def interface_modifier(interface_name: str) -> str:
    return f"interface={interface_name},allow-other-interface=false,dns-follow-interface=true"


def external_policy_modifier(
    interface_name: str | None, underlying_proxy: str | None = None
) -> str | None:
    modifiers: list[str] = []
    if underlying_proxy:
        modifiers.append(f"underlying-proxy={underlying_proxy}")
    if interface_name:
        modifiers.append(interface_modifier(interface_name))
    if not modifiers:
        return None
    return f'external-policy-modifier="{",".join(modifiers)}"'


def relay_interface_policy(interface_name: str) -> str:
    return f"🛜 网卡 {interface_name}"


def relay_interface_policies() -> list[str]:
    return [
        relay_interface_policy(interface_name)
        for interface_name in RELAY_INTERFACE_NAMES
    ]


def generate_proxy_section(interface_name: str | None) -> str:
    lines = [*MAC_INTERFACE_NOTES]
    if interface_name:
        lines.append(
            f"{DEFAULT_INTERFACE_POLICY} = direct,{interface_modifier(interface_name)}"
        )
    for relay_interface_name in RELAY_INTERFACE_NAMES:
        lines.append(
            f"{relay_interface_policy(relay_interface_name)} = direct,"
            f"{interface_modifier(relay_interface_name)}"
        )
    lines.append("")
    return "\n".join(lines)


def generate_relay_choices(relay_url: str | None) -> list[str]:
    choices: list[str] = []
    if relay_url:
        choices.extend(
            (
                "🇭🇰 香港中转",
                "🇸🇬 新加坡中转",
                "🇺🇲 美国中转",
                "🇯🇵 日本中转",
            )
        )
    choices.append(CELLULAR_POLICY_GROUP)
    choices.append(RELAY_INTERFACE_POLICY)
    choices.append("DIRECT")
    return choices


def maybe_hidden(hide_node_groups: bool) -> list[str]:
    return ["hidden=true"] if hide_node_groups else []


def always_hidden() -> list[str]:
    return ["hidden=true"]


def should_hide_node_group(group_name: str, hide_node_groups: bool) -> bool:
    if not hide_node_groups:
        return False
    if group_name in {LANDING_PROVIDER_GROUP, "🚀 默认节点"}:
        return False
    return (
        group_name.endswith("节点")
        or group_name.endswith("中转")
        or group_name == RELAY_PROVIDER_GROUP
    )


def generate_provider_groups(
    relay_url: str | None,
    proxy_url: str,
    interface_name: str | None,
    hide_node_groups: bool,
) -> str:
    proxy_modifier = external_policy_modifier(
        interface_name, underlying_proxy="🔀 中转代理"
    )
    proxy_fields = [
        f"{LANDING_PROVIDER_GROUP} = select",
        f"policy-path={proxy_url}",
        *always_hidden(),
    ]
    if proxy_modifier:
        proxy_fields.append(proxy_modifier)
    return "\n".join(
        [
            "# External policies. Replace placeholder URLs locally or pass --proxy-url/--relay-url.",
            "🔀 中转代理 = select," + ",".join(generate_relay_choices(relay_url)),
            ",".join(
                [
                    f"{CELLULAR_POLICY_GROUP} = select",
                    "CELLULAR-ONLY",
                    *always_hidden(),
                ]
            ),
            f"{RELAY_INTERFACE_POLICY} = select,"
            + ",".join(relay_interface_policies()),
            ",".join(proxy_fields),
            "",
        ]
    )


def generate_relay_groups(
    relay_url: str, interface_name: str | None, hide_node_groups: bool
) -> str:
    exclude_prefix = f"(?i)^(?!.*({EXCLUDED_NODE_PATTERN})).*"
    hidden_fields = maybe_hidden(hide_node_groups)
    relay_fields = [
        f"{RELAY_PROVIDER_GROUP} = select",
        f"policy-path={relay_url}",
        *always_hidden(),
    ]
    relay_modifier = external_policy_modifier(interface_name)
    if relay_modifier:
        relay_fields.append(relay_modifier)
    return "\n".join(
        [
            ",".join(relay_fields),
            (
                "🇭🇰 香港中转 = smart,"
                f"include-other-group={RELAY_PROVIDER_GROUP},"
                f"{','.join(hidden_fields) + ',' if hidden_fields else ''}"
                f'policy-regex-filter="{exclude_prefix}(香港|港|HK|Hong Kong).*$"'
            ),
            (
                "🇸🇬 新加坡中转 = smart,"
                f"include-other-group={RELAY_PROVIDER_GROUP},"
                f"{','.join(hidden_fields) + ',' if hidden_fields else ''}"
                f'policy-regex-filter="{exclude_prefix}(新加坡|坡|狮城|SG|Singapore).*$"'
            ),
            (
                "🇺🇲 美国中转 = smart,"
                f"include-other-group={RELAY_PROVIDER_GROUP},"
                f"{','.join(hidden_fields) + ',' if hidden_fields else ''}"
                f'policy-regex-filter="{exclude_prefix}(美国|US|United States|洛杉矶|西雅图|硅谷|圣何塞).*$"'
            ),
            (
                "🇯🇵 日本中转 = smart,"
                f"include-other-group={RELAY_PROVIDER_GROUP},"
                f"{','.join(hidden_fields) + ',' if hidden_fields else ''}"
                f'policy-regex-filter="{exclude_prefix}(日本|东京|大阪|泉日|埼玉|JP|Japan).*$"'
            ),
        ]
    )


def generate_proxy_groups(
    relay_url: str | None,
    proxy_url: str,
    interface_name: str | None,
    hide_node_groups: bool,
) -> str:
    lines = [
        "# Generated from full.ini custom_proxy_group by scripts/generate_surge.py.",
        generate_provider_groups(
            relay_url, proxy_url, interface_name, hide_node_groups
        ).rstrip(),
        *[
            convert_proxy_group(group, relay_url, interface_name, hide_node_groups)
            for group in parse_proxy_groups()
        ],
    ]
    if relay_url:
        lines.extend(
            [
                "# Relay subscription groups are placed at the bottom by design.",
                generate_relay_groups(
                    relay_url, interface_name, hide_node_groups
                ).rstrip(),
            ]
        )
    lines.append("")
    return "\n".join(lines)


def convert_ruleset(
    ruleset: RuleSet, converted_rulesets: dict[RuleSet, ConvertedRuleSet]
) -> str:
    policy = ruleset.policy
    target = ruleset.target
    if target.startswith("[]"):
        inline_rule = target.removeprefix("[]")
        rule_parts = [part.strip() for part in inline_rule.split(",") if part.strip()]
        rule_type = RULE_TYPE_ALIASES.get(rule_parts[0].upper(), rule_parts[0].upper())
        if rule_type == "FINAL":
            return f"FINAL,{policy}"
        return ",".join([rule_type, *rule_parts[1:], policy])
    target = converted_rulesets[ruleset].target
    options = [option for option in ruleset.options if option]
    return ",".join(["RULE-SET", target, policy, *options])


def generate_rules(
    rulesets: list[RuleSet], converted_rulesets: dict[RuleSet, ConvertedRuleSet]
) -> str:
    rules: list[str] = [
        "# Generated from full.ini by scripts/generate_surge.py.",
        "# Keeps the same enabled ruleset order and policy names as full.ini.",
        "# URL rulesets point to converted Surge-compatible files under surge/rules/.",
        "",
    ]
    rules.extend(convert_ruleset(rule, converted_rulesets) for rule in rulesets)
    rules.append("")
    return "\n".join(rules)


def generate_config(
    relay_url: str | None,
    proxy_url: str,
    interface_name: str | None,
    hide_node_groups: bool,
    rulesets: list[RuleSet],
    converted_rulesets: dict[RuleSet, ConvertedRuleSet],
) -> str:
    template = SURGE_TEMPLATE.read_text(encoding="utf-8")
    sections = {
        PROXY_SECTION_PLACEHOLDER: generate_proxy_section(interface_name).rstrip(),
        PROXY_GROUP_SECTION_PLACEHOLDER: generate_proxy_groups(
            relay_url, proxy_url, interface_name, hide_node_groups
        ).rstrip(),
        RULE_SECTION_PLACEHOLDER: generate_rules(rulesets, converted_rulesets).rstrip(),
    }
    for placeholder, section in sections.items():
        if placeholder not in template:
            raise RuntimeError(f"missing template placeholder: {placeholder}")
        template = template.replace(placeholder, section)
    return template.rstrip() + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Surge config from full.ini.")
    parser.add_argument(
        "--relay-url",
        "--airport-a-url",
        dest="relay_url",
        default=None,
        help="Optional Surge-compatible policy list URL for relay nodes. If omitted, relay subscription groups are not generated.",
    )
    parser.add_argument(
        "--proxy-url",
        "--airport-b-url",
        dest="proxy_url",
        default=PROXY_URL_PLACEHOLDER,
        help="Surge-compatible policy list URL for landing proxy nodes.",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output Surge config path. Defaults to surge/full.conf, or surge/full.local.conf with --agent-test.",
    )
    parser.add_argument(
        "--agent-test",
        action="store_true",
        help="Write to surge/full.local.conf by default for agent validation runs.",
    )
    parser.add_argument(
        "--interface",
        default=None,
        help="Optional default egress network interface injected into external policies and exposed as a selectable direct policy on Surge Mac.",
    )
    parser.add_argument(
        "--hide-node-groups",
        "--hide-nodes",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Hide bottom regional node groups and relay node groups by default. Use --no-hide-node-groups to show them.",
    )
    parser.add_argument(
        "--refresh-rules",
        action="store_true",
        help="Download and reconvert all URL rulesets. By default, existing converted rules are reused.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = (
        Path(args.output)
        if args.output
        else (AGENT_TEST_OUTPUT if args.agent_test else DEFAULT_OUTPUT)
    )
    if not output.is_absolute():
        output = ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)

    rulesets = parse_full_ini()
    converted_rulesets = write_converted_rulesets(
        rulesets, refresh_rules=args.refresh_rules
    )
    output.write_text(
        generate_config(
            args.relay_url,
            args.proxy_url,
            args.interface,
            args.hide_node_groups,
            rulesets,
            converted_rulesets,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
