import type { ImpDatabase } from '../../platform/db/open-database';

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
