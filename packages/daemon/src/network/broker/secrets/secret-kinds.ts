import type { SecretKind } from '@impz/api';
import { buildPendingState, formatOAuthState, parseOAuthState } from './oauth-state';

interface StoredCredential {
  readonly value: string;
  readonly oauth: { readonly refreshedAt: number | null } | null;
}

interface SecretKindRules {
  readonly formatValueFile: (value: string) => string;
  readonly findCredential: (content: string) => StoredCredential | null;
  readonly isRefreshed: boolean;
}

export const SECRET_KINDS = {
  static: {
    formatValueFile: (value) => value,
    findCredential: (content) => ({ value: content, oauth: null }),
    isRefreshed: false,
  },
  oauth: {
    formatValueFile: (refreshToken) => formatOAuthState(buildPendingState(refreshToken)),
    findCredential: (content) => {
      const state = parseOAuthState(content);

      return state === null || state.accessToken === null
        ? null
        : { value: state.accessToken, oauth: { refreshedAt: state.refreshedAt } };
    },
    isRefreshed: true,
  },
} as const satisfies Readonly<Record<SecretKind, SecretKindRules>>;
