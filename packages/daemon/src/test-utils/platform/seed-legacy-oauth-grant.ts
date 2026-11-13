import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { QueryExecutorProvider } from 'kysely';

const ORIGIN = 'http://127.0.0.1:7171';

interface LegacyToken {
  readonly kind: 'refresh' | 'access';
  readonly id: string;
  readonly token: string;
  readonly scopes: readonly string[];
  readonly expiresInMs: number;

  // a refresh token the client already traded for a new one
  readonly isRotated?: boolean;

  // the refresh token an access token came with
  readonly refreshID?: string;
}

export interface LegacyOAuthGrant {
  readonly grantID: string;
  readonly clientID: string;
  readonly clientName: string;

  // the imp token that approved the grant, and the imps the approval gave, or null for every imp
  readonly tokenID: string;
  readonly imps: readonly string[] | null;
  readonly tokens: readonly LegacyToken[];
}

// Writes a grant as impd 6.12 wrote it: a client row, one user row per grant that names the
// approving imp token and the grant's imps, and tokens stored by their SHA-256 digest. Each time is
// relative to now.
export async function seedLegacyOAuthGrant(
  db: QueryExecutorProvider,
  grant: Readonly<LegacyOAuthGrant>,
): Promise<void> {
  const created = formatOffsetTime(-120_000);
  const resources = JSON.stringify([`${ORIGIN}/mcp`]);
  const code = `code-${grant.grantID}`;
  const imps = grant.imps === null ? null : JSON.stringify(grant.imps);

  await sql`INSERT OR IGNORE INTO oauthClient (id, clientId, disabled, scopes,
      clientCredentialsScopes, createdAt, updatedAt, name, redirectUris, tokenEndpointAuthMethod,
      applicationType, grantTypes, responseTypes, requirePKCE, dpopBoundAccessTokens)
    VALUES (${`row-${grant.clientID}`}, ${grant.clientID}, 0,
      '["read","exec","manage","offline_access"]', '[]', ${created}, ${created},
      ${grant.clientName}, '["https://client.example/callback"]', 'none', 'web',
      '["authorization_code","refresh_token"]', '["code"]', 1, 0)`.execute(db);

  await sql`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt,
      tokenId, imps, lastUsedAt)
    VALUES (${grant.grantID}, 'approval', ${`${grant.grantID}@approval.imp.invalid`}, 1, NULL,
      ${created}, ${created}, ${grant.tokenID}, ${imps}, NULL)`.execute(db);

  for (const token of grant.tokens) {
    const digest = createHash('sha256').update(token.token).digest('base64url');
    const scopes = JSON.stringify(token.scopes);
    const expiresAt = formatOffsetTime(token.expiresInMs);

    if (token.kind === 'refresh') {
      const rotatedAt = token.isRotated === true ? formatOffsetTime(-60_000) : null;

      await sql`INSERT INTO oauthRefreshToken (id, token, clientId, sessionId, userId,
          authorizationCodeId, resources, expiresAt, createdAt, revoked, rotatedAt, authTime,
          scopes)
        VALUES (${token.id}, ${digest}, ${grant.clientID}, NULL, ${grant.grantID}, ${code},
          ${resources}, ${expiresAt}, ${created}, ${rotatedAt}, ${rotatedAt}, ${created},
          ${scopes})`.execute(db);

      continue;
    }

    await sql`INSERT INTO oauthAccessToken (id, token, clientId, sessionId, userId,
        authorizationCodeId, resources, refreshId, expiresAt, createdAt, revoked, scopes)
      VALUES (${token.id}, ${digest}, ${grant.clientID}, NULL, ${grant.grantID}, ${code},
        ${resources}, ${token.refreshID ?? null}, ${expiresAt}, ${formatOffsetTime(-60_000)}, NULL,
        ${scopes})`.execute(db);
  }
}

function formatOffsetTime(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}
