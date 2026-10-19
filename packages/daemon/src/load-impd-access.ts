import { createRevocations } from './auth/revocations';
import { loadTokenStore } from './auth/token-store';
import type { Config } from './config';
import type { ImpdDeps } from './impd-deps';
import { createMcpAuth } from './oauth/create-mcp-auth';
import { printLog } from './process/print-log';

// The API tokens, their revocations and the OAuth grants on top of them
export async function loadImpdAccess(
  config: Config,
  deps: Readonly<ImpdDeps>,
  isFileKey: (blob: Buffer) => boolean,
) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? printLog;
  const revocations = createRevocations();

  const tokens = await loadTokenStore({
    db: deps.db,
    rootToken: deps.rootToken,
    now,
    onRemove: revocations.revoke,
    isFileKey,
  });

  const oauth = createMcpAuth({
    db: deps.db,
    tokens,
    revocations,
    config: config.publicMcp,
    now,
    log,
  });

  return { revocations, tokens, oauth };
}

export type ImpdAccess = Readonly<Awaited<ReturnType<typeof loadImpdAccess>>>;
