import { ClientTarget } from './types.js';
import { readRulesetSource } from './local-source.js';

// ─── Rule type tables ────────────────────────────────────────────────────────

const SR_ALIASES: Record<string, string> = { 'DEST-PORT': 'DST-PORT' };
const SR_SUPPORTED = new Set([
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-WILDCARD', 'DOMAIN-SET',
  'GEOIP', 'IP-ASN', 'IP-CIDR', 'IP-CIDR6', 'PROCESS-NAME',
  'RULE-SET', 'SCRIPT', 'SRC-IP-CIDR', 'DST-PORT', 'USER-AGENT', 'URL-REGEX',
]);

const SURGE_ALIASES: Record<string, string> = { 'DST-PORT': 'DEST-PORT', 'SRC-IP-CIDR': 'SRC-IP' };
const SURGE_SUPPORTED = new Set([
  'AND', 'DOMAIN', 'DOMAIN-KEYWORD', 'DOMAIN-SET', 'DOMAIN-SUFFIX', 'DOMAIN-WILDCARD',
  'DEST-PORT', 'GEOIP', 'IN-PORT', 'IP-ASN', 'IP-CIDR', 'IP-CIDR6',
  'NOT', 'OR', 'PROCESS-NAME', 'PROTOCOL', 'RULE-SET', 'SCRIPT',
  'SRC-IP', 'SRC-PORT', 'USER-AGENT', 'URL-REGEX',
]);

function aliasesFor(target: ClientTarget) {
  return target === 'surge' ? SURGE_ALIASES : SR_ALIASES;
}
function supportedFor(target: ClientTarget) {
  return target === 'surge' ? SURGE_SUPPORTED : SR_SUPPORTED;
}

// ─── Line conversion ─────────────────────────────────────────────────────────

function cleanYamlLine(line: string): string {
  let s = line.trim();
  if (s.startsWith('- ')) s = s.slice(2).trim();
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === "'" || s[0] === '"')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function convertLine(raw: string, target: ClientTarget): string | null {
  const line = cleanYamlLine(raw);
  if (!line || line.startsWith(';')) return null;
  if (line.startsWith('#')) return line;
  if (line === 'payload:' || line === 'rules:') return null;

  const parts = line.split(',').map(p => p.trim());
  if (!parts.length) return null;

  const aliases = aliasesFor(target);
  const supported = supportedFor(target);
  const ruleType = aliases[parts[0].toUpperCase()] ?? parts[0].toUpperCase();
  if (!supported.has(ruleType)) return line;

  return [ruleType, ...parts.slice(1)].join(',');
}

export function convertRulesetContent(content: string, target: ClientTarget): string {
  const lines: string[] = [];
  for (const raw of content.split('\n')) {
    const converted = convertLine(raw, target);
    if (converted !== null) lines.push(converted);
  }
  return lines.join('\n').trimEnd() + '\n';
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleRuleset(
  _index: number,
  target: ClientTarget,
  allowedUrls: Set<string>,
  rulesetUrl: string,
): Promise<Response> {
  if (!allowedUrls.has(rulesetUrl)) {
    return new Response('Not found', { status: 404 });
  }

  let raw: string;
  try {
    raw = readRulesetSource(rulesetUrl).content;
  } catch (e) {
    return new Response(`Failed to read local ruleset: ${String(e)}`, { status: 502 });
  }

  const converted = convertRulesetContent(raw, target);
  return rulesetResponse(converted);
}

function rulesetResponse(body: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
