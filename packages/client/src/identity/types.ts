import type { IdentityTrustDocument } from '@impz/api';

export interface VerifiedImp {
  // `iss`: the impd that signed
  readonly issuer: string;

  // `sub`: unique on one impd only, so the pair of issuer and id names an imp
  readonly id: string;

  // `imp_name`, for logs. A name is free again after a destroy, so it is no key.
  readonly name: string;
}

export interface VerifyOptions {
  // One `impz identity jwks` document per impd the service trusts, pinned in
  // its configuration. Never empty, and never two with one issuer.
  readonly issuers: readonly IdentityTrustDocument[];

  // the service's guest-facing host
  readonly audience: string;

  // the service's clock, in seconds
  readonly nowSeconds: number;
}

// What the session host knows about the imp that runs a session.
export interface SessionHost {
  readonly impID: string | null;
  readonly impIssuer: string | null;
  readonly impName: string | null;
}

export type SessionCheck =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'no-identity'
        | 'unknown-session'
        | 'not-in-an-imp'
        | 'imp-id-unknown'
        | 'imp-issuer-unknown'
        | 'other-host'
        | 'other-imp';
    };
