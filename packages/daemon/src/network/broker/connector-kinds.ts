import type { BrokerRule, SecretKind } from '@impz/api';

interface Preset {
  readonly rules: readonly BrokerRule[];

  // a tool checks these before it sends anything: gh with none stops at
  // `gh auth login`
  readonly env: readonly string[];
}

export const PLACEHOLDER = 'imp-broker-placeholder';

const PRESETS: Readonly<Record<Exclude<SecretKind, 'custom' | 'oauth'>, Preset>> = {
  // git smart HTTP on github.com takes Basic auth; the REST and upload APIs
  // take a bearer token
  github: {
    rules: [
      { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
      { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
    ],
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
  },
  anthropic: {
    rules: [{ host: 'api.anthropic.com', header: 'x-api-key', scheme: 'raw' }],
    env: ['ANTHROPIC_API_KEY'],
  },
  npm: {
    rules: [{ host: 'registry.npmjs.org', header: 'authorization', scheme: 'bearer' }],
    env: ['NPM_TOKEN'],
  },
};

export class SecretRulesError extends Error {
  override name = 'SecretRulesError';
}

export function resolveRules(
  kind: SecretKind,
  given: readonly BrokerRule[] | undefined,
): readonly BrokerRule[] {
  if (kind !== 'custom' && kind !== 'oauth') {
    if (given !== undefined) {
      throw new SecretRulesError(
        `kind ${kind} has its own hosts; rules are for kinds custom and oauth`,
      );
    }

    return PRESETS[kind].rules;
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

  return given;
}

export function listPlaceholderEnv(kinds: readonly SecretKind[]): readonly string[] {
  const names = kinds.flatMap((kind) =>
    kind === 'custom' || kind === 'oauth' ? [] : PRESETS[kind].env,
  );

  return [...new Set(names)];
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
