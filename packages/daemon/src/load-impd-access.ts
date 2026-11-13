import type { Config } from './config';
import { createRevocations } from './identity/auth/revocations';
import { loadTokenStore } from './identity/auth/token-store';
import { createImpdMcpAuth } from './identity/oauth/create-impd-mcp-auth';
import type { ImpdDeps } from './impd-deps';

interface GrantRemoval {
  remove: (tokenID: string) => Promise<void>;
}

export async function loadImpdAccess(
  config: Config,
  deps: Readonly<ImpdDeps>,
  isFileKey: (blob: Buffer) => boolean,
) {
  const now = deps.now ?? Date.now;
  const revocations = createRevocations();

  // the OAuth server reads the tokens, so it opens after them, and a token's removal reaches it
  // through this holder
  const grants: GrantRemoval = { remove: () => Promise.resolve() };

  const tokens = await loadTokenStore({
    db: deps.db,
    rootToken: deps.rootToken,
    now,
    onRemove: revocations.revoke,
    removeGrants: (tokenID) => grants.remove(tokenID),
    isFileKey,
  });

  const oauth = await createImpdMcpAuth({
    db: deps.db,
    tokens,
    revocations,
    config: config.publicMcp,
    now,
  });

  grants.remove = oauth.removeTokenGrants;

  return { revocations, tokens, oauth };
}

export type ImpdAccess = Readonly<Awaited<ReturnType<typeof loadImpdAccess>>>;
