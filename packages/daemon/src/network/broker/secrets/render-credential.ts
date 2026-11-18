import type { BrokerRule } from '@impz/api';

export const PLACEHOLDER = 'imp-broker-placeholder';

export function listPlaceholderEnv(envLists: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(envLists.flat())];
}

export function renderCredential(rule: Readonly<BrokerRule>, value: string): string {
  if (rule.scheme === 'bearer') {
    return `Bearer ${value}`;
  }

  if (rule.scheme === 'basic') {
    return `Basic ${Buffer.from(`${rule.user ?? ''}:${value}`).toString('base64')}`;
  }

  return value;
}
