import { EGRESS_MODE_TRAITS } from '@impz/api';
import type { EgressPolicy } from '@impz/api';
import { parseCidr } from '../../host-net/net/parse-cidr';
import { buildRangeMatcher } from '../../host-net/net/range-matcher';

export interface AllowRules {
  readonly names: ReadonlySet<string>;
  readonly suffixes: readonly string[];
  readonly cidrs: readonly string[];

  readonly isAddressIn: (address: string) => boolean;
}

export function buildAllowRules(allow: readonly string[]): AllowRules {
  const names = new Set<string>();

  const suffixes: string[] = [];
  const cidrs: string[] = [];

  for (const entry of allow) {
    const range = parseCidr(entry);

    if (range !== null) {
      cidrs.push(`${entry.split('/')[0] ?? ''}/${String(range.bits)}`);
    } else if (entry.startsWith('*.')) {
      suffixes.push(entry.slice(1));
    } else {
      names.add(entry);
    }
  }

  return { names, suffixes, cidrs, isAddressIn: buildRangeMatcher(cidrs) };
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/u, '');
}

export function isNameAllowed(rules: AllowRules, name: string): boolean {
  const normal = normalizeName(name);

  return rules.names.has(normal) || rules.suffixes.some((suffix) => normal.endsWith(suffix));
}

export function isTunnelAllowed(policy: EgressPolicy, host: string): boolean {
  const traits = EGRESS_MODE_TRAITS[policy.mode];

  if (!traits.hasAllowList) {
    return traits.isOpen || traits.isPublic;
  }

  const rules = buildAllowRules(policy.allow);

  return isNameAllowed(rules, host) || rules.isAddressIn(host);
}

export function listExactNames(allow: readonly string[]): readonly string[] {
  return [...buildAllowRules(allow).names];
}
