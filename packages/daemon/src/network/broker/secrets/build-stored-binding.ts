import { SECRET_PRESETS } from '@impz/api';
import type { BrokerRule, OAuthConfig, SecretAdd, SecretKind, SecretPreset } from '@impz/api';
import { P, match } from 'ts-pattern';

export interface StoredBinding {
  readonly kind: SecretKind;
  readonly rules: readonly BrokerRule[];
  readonly env: readonly string[];
  readonly oauth: OAuthConfig | null;
}

export function buildStoredBinding(input: Readonly<SecretAdd>): StoredBinding {
  return match(input)
    .returnType<StoredBinding>()
    .with({ kind: 'static' }, (given) => ({
      kind: 'static',
      rules: given.rules,
      env: given.env ?? [],
      oauth: null,
    }))
    .with({ kind: 'oauth' }, (given) => ({
      kind: 'oauth',
      rules: given.rules,
      env: given.env ?? [],
      oauth: given.oauth,
    }))
    .with({ preset: P.string }, (given) => buildPresetBinding(given.preset))
    .with({ kind: 'custom' }, (given) => ({
      kind: 'static',
      rules: given.rules,
      env: [],
      oauth: null,
    }))
    .with({ kind: P.union('github', 'anthropic', 'npm') }, (given) =>
      buildPresetBinding(given.kind),
    )
    .exhaustive();
}

function buildPresetBinding(preset: SecretPreset): StoredBinding {
  return { ...SECRET_PRESETS[preset], oauth: null };
}
