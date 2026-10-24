import type { Grant, GrantFilter, Secret } from '@impz/api';
import type { GrantAuthority } from '../platform/db/secrets';

export interface ImpGrants {
  readonly addGrant: (
    impName: string,
    secretName: string,
    authority?: Readonly<GrantAuthority> | null,
    filter?: GrantFilter,
  ) => Promise<void>;
  readonly listSecrets: () => Promise<Secret[]>;
  readonly listGrantDetails: (impName: string) => Promise<Grant[]>;
}
