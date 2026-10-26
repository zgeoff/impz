import { SECRET_PRESETS } from '@impz/api';
import type { BrokerRule, SecretKind } from '@impz/api';

export const PLACEHOLDER = 'imp-broker-placeholder';

export interface SecretBinding {
  readonly rules: readonly BrokerRule[];
  readonly env: readonly string[];
}

export class SecretRulesError extends Error {
  override name = 'SecretRulesError';
}

export function resolveBinding(
  kind: SecretKind,
  given: readonly BrokerRule[] | undefined,
): SecretBinding {
  if (kind !== 'custom' && kind !== 'oauth') {
    if (given !== undefined) {
      throw new SecretRulesError(
        `kind ${kind} has its own hosts; rules are for kinds custom and oauth`,
      );
    }

    return SECRET_PRESETS[kind];
  }

  if (given === undefined || given.length === 0) {
    throw new SecretRulesError(`kind ${kind} needs at least one host`);
  }

  if (kind !== 'custom' && given.some((rule) => rule.upstream !== undefined)) {
    throw new SecretRulesError(`kind ${kind} cannot have an upstream; it is for kind custom`);
  }

  const hosts = given.map((rule) => rule.host);
  const repeated = hosts.find((host, index) => hosts.indexOf(host) !== index);

  if (repeated !== undefined) {
    throw new SecretRulesError(`${repeated} has more than one rule`);
  }

  return { rules: given, env: [] };
}

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
