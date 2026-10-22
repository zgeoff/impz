import type { DevEnv } from './build-dev-layout.ts';

export type OpRef =
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'missing'; readonly message: string };

// impz names no 1Password vault of its own, so a reference needs the variable or IMP_OP_VAULT.
export function resolveOpRef(env: DevEnv, variable: string, item: string): OpRef {
  const ref = env[variable] ?? '';

  if (ref !== '') {
    return { kind: 'ref', ref };
  }

  const vault = env['IMP_OP_VAULT'] ?? '';

  if (vault !== '') {
    return { kind: 'ref', ref: `op://${vault}/${item}` };
  }

  return {
    kind: 'missing',
    message: `impz: set IMP_OP_VAULT to the 1Password vault that holds ${item}, or ${variable} to its reference`,
  };
}
