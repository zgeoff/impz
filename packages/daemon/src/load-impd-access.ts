import type { Config } from './config';
import { createRevocations } from './identity/auth/revocations';
import { loadTokenStore } from './identity/auth/token-store';
import { createMcpAuth } from './identity/oauth/create-mcp-auth';
import type { ImpdDeps } from './impd-deps';

export async function loadImpdAccess(
  config: Config,
  deps: Readonly<ImpdDeps>,
  isFileKey: (blob: Buffer) => boolean,
) {
  const now = deps.now ?? Date.now;
  const revocations = createRevocations();

  const tokens = await loadTokenStore({
    db: deps.db,
    rootToken: deps.rootToken,
    now,
    onRemove: revocations.revoke,
    isFileKey,
  });

  const oauth = await createMcpAuth({
    db: deps.db,
    tokens,
    revocations,
    config: config.publicMcp,
    now,
  });

  return { revocations, tokens, oauth };
}

export type ImpdAccess = Readonly<Awaited<ReturnType<typeof loadImpdAccess>>>;
