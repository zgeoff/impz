import type { ImpClient } from '@impz/client';
import { ORPCError, safe } from '@orpc/client';

export type LoginResult = 'ok' | 'wrong-token' | 'failed';

export async function sendLogin(client: ImpClient, token: string): Promise<LoginResult> {
  const result = await safe(client.auth.login({ token }));

  if (result.error === null) {
    return 'ok';
  }

  if (result.isDefined && result.error.code === 'UNAUTHORIZED') {
    return 'wrong-token';
  }

  if (result.error instanceof ORPCError) {
    return 'failed';
  }

  throw result.error;
}

export async function sendLogout(client: ImpClient): Promise<void> {
  const result = await safe(client.auth.logout());

  if (result.error === null) {
    return;
  }

  throw result.error instanceof ORPCError
    ? new Error(`impd did not log out (HTTP ${String(result.error.status)})`)
    : result.error;
}
