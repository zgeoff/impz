import type { ImpDatabase } from '../db/open-database';

// A code exchange binds its tokens to the session that approved them; once
// issued, no token needs it, so every session a token holds goes, with the
// expired ones.
export async function removeTokenSessions(db: ImpDatabase): Promise<void> {
  const held = await db
    .selectFrom('oauthAccessToken')
    .select('sessionId')
    .where('sessionId', 'is not', null)
    .union(
      db.selectFrom('oauthRefreshToken').select('sessionId').where('sessionId', 'is not', null),
    )
    .execute();

  const sessionIDs = held.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]));

  await db
    .deleteFrom('session')
    .where((eb) =>
      eb.or([
        eb('expiresAt', '<', new Date().toISOString()),
        ...(sessionIDs.length === 0 ? [] : [eb('id', 'in', sessionIDs)]),
      ]),
    )
    .execute();
}
