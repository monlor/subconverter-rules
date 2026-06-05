#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from generate_surge import (
    EXCLUDED_NODE_PATTERN,
    FULL_NODE_SELECT_GROUPS,
    ROOT,
    RuleSet,
    parse_full_ini,
    parse_proxy_groups,
    parse_test_options,
    parsed_group_items,
    ruleset_filename,
)

DEFAULT_OUTPUT = ROOT / "clash" / "full.yaml"
AGENT_TEST_OUTPUT = ROOT / "clash" / "full.local.yaml"
PROXY_URL_PLACEHOLDER = "https://example.invalid/PROXY_CLASH_URL"
LANDING_PROVIDER = "landing"
RELAY_PROVIDER = "relay"
LANDING_PROVIDER_GROUP = "代理节点"
RELAY_PROVIDER_GROUP = "中转节点"
RELAY_DIALER_GROUP = "🔀 中转代理"
RELAY_INTERFACE_POLICY = "↔️ 中转网卡"
DEFAULT_HEALTH_CHECK_URL = "http://www.gstatic.com/generate_204"
CLASH_INTERFACE_NOTES = (
    "# Common interface names for selectable chaining:",
    "# macOS/iOS: en0-en10, bridge0, pdp_ip0",
    "# Linux: eth0, eth1, wlan0, wlan1, enp0s3, enp1s0, enp2s0, ens3, ens18, ens33, wlp2s0, wlp3s0, usb0",
    "# Android: wlan0, rmnet_data0, rmnet_data1, ccmni0, ccmni1, usb0",
    '# Windows: "Ethernet", "Ethernet 2", "Wi-Fi", "WLAN", "以太网", "以太网 2"',
)
CLASH_INTERFACE_NAMES = (
    *(f"en{index}" for index in range(11)),
    "bridge0",
    "pdp_ip0",
    "eth0",
    "eth1",
    "wlan0",
    "wlan1",
    "enp0s3",
    "enp1s0",
    "enp2s0",
    "ens3",
    "ens18",
    "ens33",
    "wlp2s0",
    "wlp3s0",
    "usb0",
    "rmnet_data0",
    "rmnet_data1",
    "ccmni0",
    "ccmni1",
    "Ethernet",
    "Ethernet 2",
    "Wi-Fi",
    "WLAN",
    "以太网",
    "以太网 2",
)


def quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def yaml_scalar(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if value is None:
        return "null"
    return quote(str(value))


def unique_rule_provider_name(ruleset: RuleSet, index: int, used: set[str]) -> str:
    filename = ruleset_filename(ruleset.target, index)
    stem = Path(filename).stem
    name = re.sub(r"[^0-9A-Za-z_-]+", "_", stem).strip("_").lower()
    if not name:
        name = f"ruleset_{index:02d}"
    if not name.startswith("ruleset_"):
        name = f"ruleset_{name}"

    candidate = name
    suffix = 2
    while candidate in used:
        candidate = f"{name}_{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def generate_proxy_provider(
    name: str,
    url: str,
    *,
    dialer_proxy: str | None = None,
    interface_name: str | None = None,
) -> list[str]:
    lines = [
        f"  {name}:",
        "    type: http",
        f"    url: {quote(url)}",
        "    interval: 3600",
        "    health-check:",
        "      enable: true",
        "      lazy: true",
        f"      url: {quote(DEFAULT_HEALTH_CHECK_URL)}",
        "      interval: 600",
    ]
    overrides: list[tuple[str, str]] = []
    if dialer_proxy:
        overrides.append(("dialer-proxy", dialer_proxy))
    if interface_name:
        overrides.append(("interface-name", interface_name))
    if overrides:
        lines.append("    override:")
        for key, value in overrides:
            lines.append(f"      {key}: {quote(value)}")
    return lines


def generate_proxy_providers(
    proxy_url: str,
    relay_url: str | None,
    interface_name: str | None,
) -> str:
    lines = [
        "# External proxy providers. HTTP providers use online URLs; local cache paths are left to mihomo.",
        "proxy-providers:",
    ]
    lines.extend(
        generate_proxy_provider(
            LANDING_PROVIDER,
            proxy_url,
            dialer_proxy=RELAY_DIALER_GROUP if relay_url else None,
            interface_name=interface_name,
        )
    )
    if relay_url:
        lines.extend(
            generate_proxy_provider(
                RELAY_PROVIDER,
                relay_url,
                interface_name=interface_name,
            )
        )
    return "\n".join(lines)


def relay_interface_policy(interface_name: str) -> str:
    return f"🛜 网卡 {interface_name}"


def relay_interface_policies() -> list[str]:
    return [
        relay_interface_policy(interface_name)
        for interface_name in CLASH_INTERFACE_NAMES
    ]


def generate_direct_proxies(relay_url: str | None) -> str:
    if not relay_url:
        return ""
    lines = [
        "# Direct outbound proxies for selectable interface chaining.",
        *CLASH_INTERFACE_NOTES,
        "proxies:",
    ]
    for interface_name in CLASH_INTERFACE_NAMES:
        lines.extend(
            [
                f"  - name: {quote(relay_interface_policy(interface_name))}",
                "    type: direct",
                "    udp: true",
                f"    interface-name: {quote(interface_name)}",
            ]
        )
    return "\n".join(lines)


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


def group_header(name: str, group_type: str) -> list[str]:
    return [
        f"- name: {quote(name)}",
        f"  type: {group_type}",
    ]


def append_sequence(lines: list[str], key: str, values: list[str]) -> None:
    if not values:
        return
    lines.append(f"  {key}:")
    for value in values:
        lines.append(f"    - {quote(value)}")


def combined_filter(regex_filters: list[str]) -> str | None:
    if not regex_filters:
        return None
    if len(regex_filters) == 1:
        return regex_filters[0]
    return "|".join(f"(?:{regex_filter})" for regex_filter in regex_filters)


def append_group_common(
    lines: list[str],
    *,
    regex_filters: list[str] | None = None,
    hidden: bool = False,
    url: str | None = None,
    interval: str | None = None,
    tolerance: str | None = None,
) -> None:
    regex_filter = combined_filter(regex_filters or [])
    if regex_filter:
        lines.append(f"  filter: {quote(regex_filter)}")
    if url:
        lines.append(f"  url: {quote(url)}")
    if interval:
        lines.append(f"  interval: {interval}")
    if tolerance:
        lines.append(f"  tolerance: {tolerance}")
    if hidden:
        lines.append("  hidden: true")


def generate_select_group(
    name: str,
    policies: list[str],
    regex_filters: list[str],
    relay_url: str | None,
    hide_node_groups: bool,
) -> list[str]:
    lines = group_header(name, "select")
    append_sequence(lines, "proxies", policies)

    should_include_filtered_nodes = (
        bool(regex_filters)
        and name != "🚀 默认节点"
        and (not policies or name in FULL_NODE_SELECT_GROUPS)
    )
    if should_include_filtered_nodes:
        providers = [LANDING_PROVIDER]
        if relay_url and name in FULL_NODE_SELECT_GROUPS:
            providers.append(RELAY_PROVIDER)
        append_sequence(lines, "use", providers)

    append_group_common(
        lines,
        regex_filters=regex_filters if should_include_filtered_nodes else None,
        hidden=should_hide_node_group(name, hide_node_groups),
    )
    return lines


def generate_provider_group(
    name: str,
    provider: str,
    *,
    hidden: bool = True,
) -> list[str]:
    lines = group_header(name, "select")
    append_sequence(lines, "use", [provider])
    append_group_common(lines, hidden=hidden)
    return lines


def generate_url_test_group(
    name: str,
    provider: str,
    regex_filter: str,
    *,
    hidden: bool,
    url: str = DEFAULT_HEALTH_CHECK_URL,
    interval: str = "300",
    tolerance: str = "",
) -> list[str]:
    lines = group_header(name, "url-test")
    append_sequence(lines, "use", [provider])
    append_group_common(
        lines,
        regex_filters=[regex_filter] if regex_filter else None,
        hidden=hidden,
        url=url,
        interval=interval,
        tolerance=tolerance,
    )
    return lines


def generate_relay_choices(relay_url: str | None) -> list[str]:
    if not relay_url:
        return []
    return [
        "🇭🇰 香港中转",
        "🇸🇬 新加坡中转",
        "🇺🇲 美国中转",
        "🇯🇵 日本中转",
        RELAY_INTERFACE_POLICY,
        "DIRECT",
    ]


def generate_relay_region_groups(hide_node_groups: bool) -> list[list[str]]:
    exclude_prefix = f"(?i)^(?!.*({EXCLUDED_NODE_PATTERN})).*"
    hidden = hide_node_groups
    return [
        generate_url_test_group(
            "🇭🇰 香港中转",
            RELAY_PROVIDER,
            f"{exclude_prefix}(香港|港|HK|Hong Kong).*$",
            hidden=hidden,
        ),
        generate_url_test_group(
            "🇸🇬 新加坡中转",
            RELAY_PROVIDER,
            f"{exclude_prefix}(新加坡|坡|狮城|SG|Singapore).*$",
            hidden=hidden,
        ),
        generate_url_test_group(
            "🇺🇲 美国中转",
            RELAY_PROVIDER,
            f"{exclude_prefix}(美国|US|United States|洛杉矶|西雅图|硅谷|圣何塞).*$",
            hidden=hidden,
        ),
        generate_url_test_group(
            "🇯🇵 日本中转",
            RELAY_PROVIDER,
            f"{exclude_prefix}(日本|东京|大阪|泉日|埼玉|JP|Japan).*$",
            hidden=hidden,
        ),
    ]


def generate_proxy_group_lines(
    relay_url: str | None,
    hide_node_groups: bool,
) -> str:
    groups: list[list[str]] = []
    if relay_url:
        relay_selector = group_header(RELAY_DIALER_GROUP, "select")
        append_sequence(relay_selector, "proxies", generate_relay_choices(relay_url))
        groups.append(relay_selector)

        relay_interface_selector = group_header(RELAY_INTERFACE_POLICY, "select")
        append_sequence(
            relay_interface_selector,
            "proxies",
            relay_interface_policies(),
        )
        groups.append(relay_interface_selector)

    groups.append(generate_provider_group(LANDING_PROVIDER_GROUP, LANDING_PROVIDER))

    for group in parse_proxy_groups():
        policies, regex_filters = parsed_group_items(group)
        if group.group_type == "select":
            groups.append(
                generate_select_group(
                    group.name,
                    policies,
                    regex_filters,
                    relay_url,
                    hide_node_groups,
                )
            )
            continue

        if group.group_type in {"url-test", "fallback", "load-balance", "random"}:
            regex_filter = group.items[0] if group.items else ""
            url, interval, tolerance = parse_test_options(group)
            group_type = "url-test" if group.group_type == "random" else group.group_type
            lines = group_header(group.name, group_type)
            append_sequence(lines, "use", [LANDING_PROVIDER])
            append_group_common(
                lines,
                regex_filters=[regex_filter] if regex_filter else None,
                hidden=should_hide_node_group(group.name, hide_node_groups),
                url=url,
                interval=interval,
                tolerance=tolerance,
            )
            groups.append(lines)
            continue

        lines = group_header(group.name, group.group_type)
        append_sequence(lines, "proxies", policies)
        append_group_common(
            lines,
            hidden=should_hide_node_group(group.name, hide_node_groups),
        )
        groups.append(lines)

    if relay_url:
        groups.append(generate_provider_group(RELAY_PROVIDER_GROUP, RELAY_PROVIDER))
        groups.extend(generate_relay_region_groups(hide_node_groups))

    lines = [
        "# Generated from full.ini custom_proxy_group by scripts/generate_clash.py.",
        "proxy-groups:",
    ]
    for index, group_lines in enumerate(groups):
        if index:
            lines.append("")
        lines.extend(f"  {line}" for line in group_lines)
    return "\n".join(lines)


def generate_rule_providers(
    rulesets: list[RuleSet],
) -> tuple[str, dict[RuleSet, str]]:
    lines = [
        "# Generated from full.ini ruleset URLs by scripts/generate_clash.py.",
        "rule-providers:",
    ]
    names: dict[RuleSet, str] = {}
    used: set[str] = set()
    url_rulesets = [
        ruleset for ruleset in rulesets if not ruleset.target.startswith("[]")
    ]
    for index, ruleset in enumerate(url_rulesets, start=1):
        name = unique_rule_provider_name(ruleset, index, used)
        names[ruleset] = name
        lines.extend(
            [
                f"  {name}:",
                "    type: http",
                f"    url: {quote(ruleset.target)}",
                "    interval: 86400",
                "    behavior: classical",
                "    format: text",
            ]
        )
    return "\n".join(lines), names


def convert_inline_rule(ruleset: RuleSet) -> str:
    inline_rule = ruleset.target.removeprefix("[]")
    rule_parts = [part.strip() for part in inline_rule.split(",") if part.strip()]
    if not rule_parts:
        raise RuntimeError(f"empty inline ruleset for policy: {ruleset.policy}")
    rule_type = rule_parts[0].upper()
    if rule_type == "FINAL":
        return f"MATCH,{ruleset.policy}"
    return ",".join([rule_type, *rule_parts[1:], ruleset.policy])


def generate_rules(rulesets: list[RuleSet], provider_names: dict[RuleSet, str]) -> str:
    lines = [
        "# Generated from full.ini by scripts/generate_clash.py.",
        "# Keeps the same enabled ruleset order and policy names as full.ini.",
        "rules:",
    ]
    for ruleset in rulesets:
        if ruleset.target.startswith("[]"):
            rule = convert_inline_rule(ruleset)
        else:
            rule = f"RULE-SET,{provider_names[ruleset]},{ruleset.policy}"
        lines.append(f"  - {quote(rule)}")
    return "\n".join(lines)


def generate_config(
    proxy_url: str,
    relay_url: str | None,
    interface_name: str | None,
    hide_node_groups: bool,
) -> str:
    rulesets = parse_full_ini()
    rule_provider_section, provider_names = generate_rule_providers(rulesets)
    sections = [
        "#!name=monlor Clash",
        "#!desc=Generated from full.ini for mihomo. Supports optional chained proxy providers through dialer-proxy.",
        "# Do not commit real subscription URLs. Generate private configs with --agent-test.",
        "",
        "mixed-port: 7890",
        "allow-lan: true",
        "mode: rule",
        "log-level: info",
        "ipv6: true",
        "unified-delay: true",
        "tcp-concurrent: true",
        "profile:",
        "  store-selected: true",
        "  store-fake-ip: true",
        "",
        generate_proxy_providers(proxy_url, relay_url, interface_name),
        "",
        generate_direct_proxies(relay_url),
        "",
        generate_proxy_group_lines(relay_url, hide_node_groups),
        "",
        rule_provider_section,
        "",
        generate_rules(rulesets, provider_names),
    ]
    return "\n".join(sections).rstrip() + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate mihomo/Clash config from full.ini."
    )
    parser.add_argument(
        "--relay-url",
        default=None,
        help="Optional Clash/Mihomo-compatible provider URL for relay nodes. If omitted, chained relay groups are not generated.",
    )
    parser.add_argument(
        "--proxy-url",
        default=PROXY_URL_PLACEHOLDER,
        help="Clash/Mihomo-compatible provider URL for landing proxy nodes.",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output Clash config path. Defaults to clash/full.yaml, or clash/full.local.yaml with --agent-test.",
    )
    parser.add_argument(
        "--agent-test",
        action="store_true",
        help="Write to clash/full.local.yaml by default for agent validation runs.",
    )
    parser.add_argument(
        "--interface",
        default=None,
        help="Optional outbound interface-name override injected into generated proxy providers.",
    )
    parser.add_argument(
        "--hide-node-groups",
        "--hide-nodes",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Hide bottom regional node groups and relay node groups by default. Use --no-hide-node-groups to show them.",
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
    output.write_text(
        generate_config(
            args.proxy_url,
            args.relay_url,
            args.interface,
            args.hide_node_groups,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
