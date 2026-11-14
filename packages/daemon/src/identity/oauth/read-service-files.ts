import { readFile } from 'node:fs/promises';
import { GrantPatternSchema, ScopeSchema } from '@impz/api';
import type { Scope } from '@impz/api';
import { getErrorMessage } from '@impz/shared';
import { parseServiceTokenFile } from '@zgeoff/mcp-auth';
import type { ServiceTokenFile } from '@zgeoff/mcp-auth';
import * as z from 'zod';
import type { ServiceFiles } from './public-mcp-config';

// Every static service token starts with this, so the OAuth server routes a bearer to the token
// file or to its database by its first characters.
export const SERVICE_TOKEN_PREFIX = 'impsvc_';
const ServiceClientSchema = z.strictObject({ imps: z.array(GrantPatternSchema).min(1).max(32) });

const ServiceClientsFileSchema = z.strictObject({
  clients: z.record(z.string(), ServiceClientSchema),
});

// by client name, without the `service:` its ID carries
export type ServiceClients = Readonly<Record<string, { readonly imps: readonly string[] }>>;

export interface ServiceSettings {
  readonly tokens: ServiceTokenFile<Scope>;
  readonly clients: ServiceClients;
}

function parseServiceClients(text: string): ServiceClients {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error('the file is not valid JSON', { cause: error });
  }

  const parsed = ServiceClientsFileSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || 'the file'}: ${issue.message}`)
        .join('; '),
    );
  }

  return parsed.data.clients;
}

export async function readServiceSettings(files: Readonly<ServiceFiles>): Promise<ServiceSettings> {
  const tokenText = await readText('IMP_MCP_SERVICE_TOKEN_FILE', files.tokenFile);
  const clientsText = await readText('IMP_MCP_SERVICE_CLIENTS_FILE', files.clientsFile);

  const tokens = parseServiceTokenFile(tokenText, {
    prefix: SERVICE_TOKEN_PREFIX,
    scopes: ScopeSchema.options,
  });

  if (!tokens.ok) {
    throw new Error(`IMP_MCP_SERVICE_TOKEN_FILE ${files.tokenFile}: ${tokens.reason}`);
  }

  try {
    return { tokens: tokens.file, clients: parseServiceClients(clientsText) };
  } catch (error) {
    throw new Error(
      `IMP_MCP_SERVICE_CLIENTS_FILE ${files.clientsFile}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

async function readText(variable: string, path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${variable} ${path} cannot be read: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
}
