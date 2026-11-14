import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServiceFiles } from './build-service-files.ts';

export interface ServiceFilePaths {
  readonly tokenFile: string;
  readonly clientsFile: string;
}

// Writes the run's two service files into `directory`, for impd's IMP_MCP_SERVICE_TOKEN_FILE and
// IMP_MCP_SERVICE_CLIENTS_FILE.
export async function writeServiceFiles(
  directory: string,
  resource: string,
  digest: string,
): Promise<ServiceFilePaths> {
  const folder = join(directory, 'service');
  const files = buildServiceFiles(resource, digest);

  const paths: ServiceFilePaths = {
    tokenFile: join(folder, 'service-tokens.json'),
    clientsFile: join(folder, 'service-clients.json'),
  };

  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(paths.tokenFile, JSON.stringify(files.tokens), { mode: 0o600 });
  await writeFile(paths.clientsFile, JSON.stringify(files.clients), { mode: 0o600 });

  return paths;
}
