import type { Credential } from './admit-request';

interface IdentityTokenDeps {
  readonly host: string;
  readonly mintIdentityToken?: ((audience: string) => string | null) | undefined;
}

// The audience is the rule's host as the guest names it, never the upstream.
export function findIdentityToken(
  deps: IdentityTokenDeps,
  credential: Readonly<Credential>,
): string | null {
  return credential.identity ? (deps.mintIdentityToken?.(deps.host) ?? null) : null;
}
