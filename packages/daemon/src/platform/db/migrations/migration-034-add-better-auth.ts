import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// better-auth 1.7.7's tables for the public MCP route, with its MCP plugin and
// imp's three user fields, names and all.
export const MIGRATION_034_ADD_BETTER_AUTH: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      await sql`
        CREATE TABLE "user" (
          "id" text NOT NULL PRIMARY KEY,
          "name" text NOT NULL,
          "email" text NOT NULL UNIQUE,
          "emailVerified" integer NOT NULL,
          "image" text,
          "createdAt" date NOT NULL,
          "updatedAt" date NOT NULL,
          "tokenId" text NOT NULL,
          "imps" text,
          "lastUsedAt" date
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "session" (
          "id" text NOT NULL PRIMARY KEY,
          "expiresAt" date NOT NULL,
          "token" text NOT NULL UNIQUE,
          "createdAt" date NOT NULL,
          "updatedAt" date NOT NULL,
          "ipAddress" text,
          "userAgent" text,
          "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "account" (
          "id" text NOT NULL PRIMARY KEY,
          "accountId" text NOT NULL,
          "providerId" text NOT NULL,
          "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
          "accessToken" text,
          "refreshToken" text,
          "idToken" text,
          "accessTokenExpiresAt" date,
          "refreshTokenExpiresAt" date,
          "scope" text,
          "password" text,
          "createdAt" date NOT NULL,
          "updatedAt" date NOT NULL
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "verification" (
          "id" text NOT NULL PRIMARY KEY,
          "identifier" text NOT NULL,
          "value" text NOT NULL,
          "expiresAt" date NOT NULL,
          "createdAt" date NOT NULL,
          "updatedAt" date NOT NULL
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "oauthClient" (
          "id" text NOT NULL PRIMARY KEY,
          "clientId" text NOT NULL UNIQUE,
          "clientSecret" text,
          "clientDiscoveryId" text,
          "disabled" integer,
          "skipConsent" integer,
          "enableEndSession" integer,
          "subjectType" text,
          "scopes" text,
          "clientCredentialsScopes" text,
          "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
          "createdAt" date,
          "updatedAt" date,
          "name" text,
          "uri" text,
          "icon" text,
          "contacts" text,
          "tos" text,
          "policy" text,
          "softwareId" text,
          "softwareVersion" text,
          "softwareStatement" text,
          "redirectUris" text NOT NULL,
          "postLogoutRedirectUris" text,
          "backchannelLogoutUri" text,
          "backchannelLogoutSessionRequired" integer,
          "tokenEndpointAuthMethod" text,
          "applicationType" text,
          "jwks" text,
          "jwksUri" text,
          "grantTypes" text,
          "responseTypes" text,
          "requirePKCE" integer,
          "dpopBoundAccessTokens" integer,
          "referenceId" text,
          "metadata" text
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "oauthResource" (
          "id" text NOT NULL PRIMARY KEY,
          "identifier" text NOT NULL UNIQUE,
          "name" text NOT NULL,
          "accessTokenTtl" integer,
          "refreshTokenTtl" integer,
          "signingAlgorithm" text,
          "signingKeyId" text,
          "allowedScopes" text,
          "customClaims" text,
          "dpopBoundAccessTokensRequired" integer,
          "disabled" integer,
          "createdAt" date,
          "updatedAt" date,
          "policyVersion" integer,
          "metadata" text
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "oauthClientResource" (
          "id" text NOT NULL PRIMARY KEY,
          "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
          "resourceId" text NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
          "metadata" text,
          "createdAt" date
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "oauthRefreshToken" (
          "id" text NOT NULL PRIMARY KEY,
          "token" text NOT NULL UNIQUE,
          "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
          "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
          "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
          "referenceId" text,
          "authorizationCodeId" text,
          "resources" text,
          "requestedUserInfoClaims" text,
          "expiresAt" date NOT NULL,
          "createdAt" date NOT NULL,
          "revoked" date,
          "rotatedAt" date,
          "rotationReplayResponse" text,
          "rotationReplayExpiresAt" date,
          "authTime" date,
          "confirmation" text,
          "scopes" text NOT NULL
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "oauthAccessToken" (
          "id" text NOT NULL PRIMARY KEY,
          "token" text NOT NULL UNIQUE,
          "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
          "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
          "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
          "referenceId" text,
          "authorizationCodeId" text,
          "resources" text,
          "requestedUserInfoClaims" text,
          "refreshId" text REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
          "expiresAt" date NOT NULL,
          "createdAt" date NOT NULL,
          "revoked" date,
          "confirmation" text,
          "scopes" text NOT NULL
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "oauthConsent" (
          "id" text NOT NULL PRIMARY KEY,
          "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
          "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
          "referenceId" text,
          "resources" text,
          "requestedUserInfoClaims" text,
          "scopes" text NOT NULL,
          "createdAt" date NOT NULL,
          "updatedAt" date NOT NULL
        )
      `.execute(trx);

      await sql`
        CREATE TABLE "oauthClientAssertion" (
          "id" text NOT NULL PRIMARY KEY,
          "expiresAt" date NOT NULL
        )
      `.execute(trx);

      await sql`CREATE INDEX "session_userId_idx" ON "session" ("userId")`.execute(trx);
      await sql`CREATE INDEX "account_userId_idx" ON "account" ("userId")`.execute(trx);

      await sql`
        CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier")
      `.execute(trx);

      await sql`CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId")`.execute(trx);

      await sql`
        CREATE UNIQUE INDEX "oauthClient_name_uidx" ON "oauthClient" ("name")
      `.execute(trx);

      await sql`
        CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId")
      `.execute(trx);

      await sql`
        CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId")
      `.execute(trx);

      await sql`
        CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx"
        ON "oauthClientResource" ("clientId", "resourceId")
      `.execute(trx);

      for (const table of ['oauthRefreshToken', 'oauthAccessToken']) {
        for (const column of ['clientId', 'sessionId', 'userId', 'authorizationCodeId']) {
          await sql`
            CREATE INDEX ${sql.id(`${table}_${column}_idx`)} ON ${sql.table(table)} (${sql.ref(column)})
          `.execute(trx);
        }
      }

      await sql`
        CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId")
      `.execute(trx);

      await sql`CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId")`.execute(
        trx,
      );

      await sql`CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId")`.execute(trx);
    });
  },
};
