#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen
import argparse
import re
import time


ROOT = Path(__file__).resolve().parents[1]
FULL_INI = ROOT / "full.ini"
LAZY_GROUP = ROOT / "shadowrocket" / "lazy_group.conf"
OUTPUT = ROOT / "shadowrocket" / "full.conf"
RULES_OUTPUT_DIR = ROOT / "shadowrocket" / "rules"
RAW_REPO_URL = "https://raw.githubusercontent.com/monlor/subconverter-rules/main/"
GH_PROXY_RAW_REPO_URL = "https://gh.monlor.com/" + RAW_REPO_URL
SHADOWROCKET_RULES_URL = GH_PROXY_RAW_REPO_URL + "shadowrocket/rules/"

RULE_TYPE_ALIASES = {
    "DEST-PORT": "DST-PORT",
}

SUPPORTED_RULE_TYPES = {
    "DOMAIN",
    "DOMAIN-SUFFIX",
    "DOMAIN-KEYWORD",
    "DOMAIN-WILDCARD",
    "DOMAIN-SET",
    "GEOIP",
    "IP-ASN",
    "IP-CIDR",
    "IP-CIDR6",
    "PROCESS-NAME",
    "RULE-SET",
    "SCRIPT",
    "SRC-IP-CIDR",
    "DST-PORT",
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


def split_lazy_config(text: str) -> tuple[str, str, str]:
    proxy_group_marker = "\n[Proxy Group]\n"
    rule_marker = "\n[Rule]\n"
    host_marker = "\n[Host]\n"
    if proxy_group_marker not in text or rule_marker not in text or host_marker not in text:
        raise ValueError("lazy_group.conf must contain [Proxy Group], [Rule], and [Host] sections")

    before_proxy_group, rest = text.split(proxy_group_marker, 1)
    _, after_rule_marker = rest.split(rule_marker, 1)
    _, after_host = after_rule_marker.split(host_marker, 1)
    return before_proxy_group + proxy_group_marker, "[Rule]\n", "[Host]\n" + after_host


def parse_full_ini() -> list[RuleSet]:
    rulesets: list[RuleSet] = []
    for raw_line in FULL_INI.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(";") or line.startswith("#"):
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
            request = Request(fetch_url, headers={"User-Agent": "subconverter-rules-shadowrocket-generator"})
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


def write_converted_rulesets(rulesets: list[RuleSet], refresh_rules: bool) -> dict[RuleSet, ConvertedRuleSet]:
    RULES_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if refresh_rules:
        for path in RULES_OUTPUT_DIR.iterdir():
            if path.is_file():
                path.unlink()

    converted: dict[RuleSet, ConvertedRuleSet] = {}
    used_filenames: set[str] = set()
    url_rulesets = [ruleset for ruleset in rulesets if not ruleset.target.startswith("[]")]

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
                raise RuntimeError(f"failed to fetch ruleset: {ruleset.target}") from exc
            output_path.write_text(convert_ruleset_content(source), encoding="utf-8")

        converted[ruleset] = ConvertedRuleSet(
            ruleset=ruleset,
            target=SHADOWROCKET_RULES_URL + filename,
        )

    return converted


def parse_proxy_groups() -> list[ProxyGroup]:
    groups: list[ProxyGroup] = []
    for raw_line in FULL_INI.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(";") or line.startswith("#"):
            continue
        if not line.startswith("custom_proxy_group="):
            continue

        payload = line.removeprefix("custom_proxy_group=")
        parts = tuple(part.strip() for part in payload.split("`"))
        if len(parts) < 2:
            continue
        groups.append(ProxyGroup(name=parts[0], group_type=parts[1], items=parts[2:]))
    return groups


def convert_group_item(item: str) -> str | None:
    if not item:
        return None
    if item.startswith("[]"):
        return item.removeprefix("[]")
    return item


def convert_proxy_group(group: ProxyGroup) -> str:
    if group.group_type == "select":
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

        if group.name == "🚀 默认" and "PROXY" not in policies:
            policies.insert(0, "PROXY")

        fields = [group.group_type, *policies]
        if not policies:
            fields.extend(f"policy-regex-filter={regex_filter}" for regex_filter in regex_filters)
        return f"{group.name} = {','.join(fields)}"

    if group.group_type in {"url-test", "fallback", "load-balance", "random"}:
        regex = group.items[0] if len(group.items) > 0 else ""
        url = group.items[1] if len(group.items) > 1 else "http://www.gstatic.com/generate_204"
        interval = "300"
        timeout = ""
        tolerance = ""
        if len(group.items) > 2:
            test_parts = [part.strip() for part in group.items[2].split(",")]
            if len(test_parts) > 0 and test_parts[0]:
                interval = test_parts[0]
            if len(test_parts) > 1 and test_parts[1]:
                timeout = test_parts[1]
            if len(test_parts) > 2 and test_parts[2]:
                tolerance = test_parts[2]

        fields = [
            group.group_type,
            f"url={url}",
            f"interval={interval}",
            "select=0",
        ]
        if timeout:
            fields.append(f"timeout={timeout}")
        if tolerance:
            fields.append(f"tolerance={tolerance}")
        if regex:
            fields.append(f"policy-regex-filter={regex}")
        return f"{group.name} = {','.join(fields)}"

    fields = [group.group_type]
    for item in group.items:
        converted = convert_group_item(item)
        if converted:
            fields.append(converted)
    return f"{group.name} = {','.join(fields)}"


def generate_proxy_groups() -> str:
    lines = [
        "# Generated from full.ini custom_proxy_group by scripts/generate_shadowrocket.py.",
        *[convert_proxy_group(group) for group in parse_proxy_groups()],
        "",
    ]
    return "\n".join(lines)


def convert_ruleset(ruleset: RuleSet, converted_rulesets: dict[RuleSet, ConvertedRuleSet]) -> str:
    policy = ruleset.policy
    target = ruleset.target
    if target.startswith("[]"):
        inline_rule = target.removeprefix("[]")
        rule_parts = [part.strip() for part in inline_rule.split(",") if part.strip()]
        rule_type = rule_parts[0].upper()
        if rule_type == "FINAL":
            return f"FINAL,{policy}"
        return ",".join(rule_parts + [policy])
    target = converted_rulesets[ruleset].target
    return f"RULE-SET,{target},{policy}"


def generate_rules(rulesets: list[RuleSet], converted_rulesets: dict[RuleSet, ConvertedRuleSet]) -> str:
    rules: list[str] = [
        "# Generated from full.ini by scripts/generate_shadowrocket.py.",
        "# Keeps the same enabled ruleset order and policy names as full.ini.",
        "# URL rulesets point to converted Shadowrocket-compatible files under shadowrocket/rules/.",
        "",
    ]
    rules.extend(convert_ruleset(rule, converted_rulesets) for rule in rulesets)
    rules.append("")
    return "\n".join(rules)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Shadowrocket config from full.ini.")
    parser.add_argument(
        "--refresh-rules",
        action="store_true",
        help="Download and reconvert all URL rulesets. By default, existing converted rules are reused.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rulesets = parse_full_ini()
    converted_rulesets = write_converted_rulesets(rulesets, refresh_rules=args.refresh_rules)
    before_rule, rule_header, after_host = split_lazy_config(LAZY_GROUP.read_text(encoding="utf-8"))
    output = before_rule + generate_proxy_groups() + rule_header + generate_rules(rulesets, converted_rulesets) + "\n" + after_host
    OUTPUT.write_text(output, encoding="utf-8")


if __name__ == "__main__":
    main()
