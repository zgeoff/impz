import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '@impz/api';
import { mintServiceSecret } from '@zgeoff/mcp-auth';
import invariant from 'tiny-invariant';
import type { ServiceFiles } from '../../identity/oauth/public-mcp-config';

interface ServiceClientInput {
  readonly name: string;
  readonly scopes: readonly Scope[];

  // the patterns of the client's entry in the clients file; null writes no entry
  readonly imps: readonly string[] | null;
}

interface SeededServiceFiles {
  readonly files: ServiceFiles;

  readonly findSecret: (name: string) => string;

  // writes the token file again, for the given clients, as a SIGHUP restart would read it
  readonly writeTokenFile: (clients: readonly ServiceClientInput[]) => Promise<void>;
}

// Writes a service-token file and a service-clients file into a temp folder that the stack
// removes, with a client secret minted per client.
export async function seedServiceFiles(
  stack: AsyncDisposableStack,
  resource: string,
  clients: readonly ServiceClientInput[],
): Promise<SeededServiceFiles> {
  const directory = await mkdtemp(join(tmpdir(), 'impd-service-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const files: ServiceFiles = {
    tokenFile: join(directory, 'service-tokens.json'),
    clientsFile: join(directory, 'service-clients.json'),
  };

  const secrets: Record<string, string> = {};
  const digests: Record<string, string> = {};

  for (const client of clients) {
    const minted = mintServiceSecret();

    secrets[client.name] = minted.secret;
    digests[client.name] = minted.digest;
  }

  const writeTokenFile = async (given: readonly ServiceClientInput[]) => {
    const entries = given.map((client) => [
      client.name,
      { scopes: client.scopes, secretDigests: [digests[client.name]] },
    ]);

    await writeFile(
      files.tokenFile,
      JSON.stringify({ resource, clients: Object.fromEntries(entries) }),
    );
  };

  await writeTokenFile(clients);

  const limited = clients.flatMap((client) =>
    client.imps === null ? [] : [[client.name, { imps: client.imps }] as const],
  );

  await writeFile(files.clientsFile, JSON.stringify({ clients: Object.fromEntries(limited) }));

  return {
    files,
    writeTokenFile,
    findSecret: (name) => {
      const secret = secrets[name];

      invariant(secret !== undefined, `no secret for ${name}`);

      return secret;
    },
  };
}
