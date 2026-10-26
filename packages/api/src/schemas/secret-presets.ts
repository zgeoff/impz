import type { BrokerRule, SecretPreset } from './secret-schema';

interface PresetBinding {
  readonly rules: readonly BrokerRule[];

  // a tool checks these before it sends anything: gh with none stops at
  // `gh auth login`
  readonly env: readonly string[];
}

export const SECRET_PRESETS = {
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
} as const satisfies Readonly<Record<SecretPreset, PresetBinding>>;
