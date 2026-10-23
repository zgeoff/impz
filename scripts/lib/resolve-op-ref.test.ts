import { expect, test } from 'bun:test';
import { resolveOpRef } from './resolve-op-ref.ts';

test('it takes the reference the variable holds over the vault', () => {
  expect(
    resolveOpRef(
      { IMP_TAILNET_OAUTH_REF: 'op://other/item', IMP_OP_VAULT: 'example' },
      'IMP_TAILNET_OAUTH_REF',
      'imp-e2e-tailscale-services',
    ),
  ).toStrictEqual({ kind: 'ref', ref: 'op://other/item' });
});

test('it builds the reference from IMP_OP_VAULT and the item', () => {
  expect(
    resolveOpRef(
      { IMP_OP_VAULT: 'example' },
      'IMP_TAILNET_OAUTH_REF',
      'imp-e2e-tailscale-services',
    ),
  ).toStrictEqual({ kind: 'ref', ref: 'op://example/imp-e2e-tailscale-services' });
});

test('it names the variables to set when neither is set', () => {
  expect(resolveOpRef({}, 'IMP_TAILNET_OAUTH_REF', 'imp-e2e-tailscale-services')).toStrictEqual({
    kind: 'missing',
    message:
      'impz: set IMP_OP_VAULT to the 1Password vault that holds imp-e2e-tailscale-services, or IMP_TAILNET_OAUTH_REF to its reference',
  });
});
