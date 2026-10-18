import type { ImpDatabase } from '../db/open-database';
import { deriveTokenHash } from './derive-token-hash';

// what a replay's check reads, and how its grant goes
interface ReplayDeps {
  readonly db: ImpDatabase;
  readonly removeGrantRows: (ids: readonly string[], why: string) => Promise<void>;
}

// A refused refresh of a spent token is a replay, even one racing the
// refresh that spent it, which better-auth refuses without revoking
// anything: the grant goes, with what the winner got.
export async function removeReplayedGrant(
  deps: ReplayDeps,
  form: Readonly<URLSearchParams>,
): Promise<void> {
  const refreshToken = form.get('refresh_token');
  const clientID = form.get('client_id');

  if (form.get('grant_type') !== 'refresh_token' || refreshToken === null || clientID === null) {
    return;
  }

  // only its own client replays a token; another client's try ends nothing
  const spent = await deps.db
    .selectFrom('oauthRefreshToken')
    .select('userId')
    .where('token', '=', deriveTokenHash(refreshToken))
    .where('clientId', '=', clientID)
    .where((eb) => eb.or([eb('revoked', 'is not', null), eb('rotatedAt', 'is not', null)]))
    .executeTakeFirst();

  if (spent !== undefined) {
    await deps.removeGrantRows([spent.userId], 'a spent refresh token came again');
  }
}
