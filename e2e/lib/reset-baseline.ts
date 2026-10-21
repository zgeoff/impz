import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImpClient } from '../../packages/client/src/index';

export interface ResetBaselineOptions {
  readonly client: ImpClient;

  readonly prefixes: readonly string[];

  readonly dataDir: string;
}

export async function resetBaseline(options: Readonly<ResetBaselineOptions>): Promise<void> {
  const client = options.client;

  const [imps, networks, secrets, oauthClients, tokens, images] = await Promise.all([
    client.imps.list(),
    client.networks.list(),
    client.secrets.list(),
    client.oauth.clients.list(),
    client.tokens.list(),
    client.images.list(),
  ]);

  const listOwned = (rows: readonly Readonly<{ name: string }>[]) =>
    rows
      .map((row) => row.name)
      .filter((name) => options.prefixes.some((prefix) => name.startsWith(prefix)));

  // impd refuses to remove an imp that a failed move left marked, so the move
  // ends first.
  for (const name of listOwned(imps.filter((imp) => imp.move !== undefined))) {
    await client.moves.abort({ name });
  }

  // Imps go first, since each holds its checkpoints, leases, networks, grants
  // and image.
  for (const name of listOwned(imps)) {
    await client.imps.destroy({ name });
  }

  for (const name of listOwned(networks)) {
    await client.networks.delete({ name });
  }

  for (const name of listOwned(secrets)) {
    await client.secrets.delete({ name });
  }

  for (const name of listOwned(oauthClients)) {
    await client.oauth.clients.delete({ name });
  }

  for (const name of listOwned(tokens)) {
    await client.tokens.delete({ name });
  }

  for (const name of listOwned(images)) {
    await client.images.delete({ name });
  }

  await rm(join(options.dataDir, 'broker-test-upstreams.json'), { force: true });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND'
  );
}

export async function removeImpIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.imps.destroy({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export async function removeTokenIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.tokens.delete({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export async function removeSecretIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.secrets.delete({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export async function removeNetworkIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.networks.delete({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export async function removeOAuthClientIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.oauth.clients.delete({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export async function removeImageIfPresent(client: ImpClient, name: string): Promise<void> {
  try {
    await client.images.delete({ name });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}
