import type { Caller } from '../../identity/auth/caller';
import type { BoundSshKey } from '../../identity/auth/token-store';
import { formatKeyFingerprint } from '../../imps/ssh/authorized-keys';
import type { AuthorizedKey, AuthorizedKeys } from '../../imps/ssh/authorized-keys';

interface LoginKey {
  readonly key: AuthorizedKey;
  readonly caller: Caller;
  readonly keyId: string | null;
}

export interface LoginKeys {
  readonly readLoginKey: (blob: Buffer) => LoginKey | null;
}

interface LoginKeysDeps {
  readonly findBound: (blob: Buffer) => BoundSshKey | null;
  readonly file: AuthorizedKeys | null;
}

export function createLoginKeys(deps: Readonly<LoginKeysDeps>): LoginKeys {
  return {
    readLoginKey: (blob) => {
      const bound = deps.findBound(blob);

      if (bound !== null) {
        return { key: bound.key, caller: bound.caller, keyId: bound.keyId };
      }

      const key = deps.file?.readKey(blob) ?? null;

      return key === null ? null : { key, caller: buildFileCaller(key), keyId: null };
    },
  };
}

function buildFileCaller(key: Readonly<AuthorizedKey>): Caller {
  const display = key.comment === '' ? key.type : key.comment;

  return {
    kind: 'ssh',
    name: `key ${display}`,
    scope: 'manage',
    imps: null,
    grantable: [],
    imageRefPrefix: null,
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: `key:${formatKeyFingerprint(key.blob)}`,
    display,
  };
}
