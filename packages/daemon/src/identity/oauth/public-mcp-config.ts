import * as z from 'zod';

export const PublicMcpEnvSchema = z.object({
  IMP_MCP_PUBLIC_URL: z.string().optional(),
  IMP_MCP_PUBLIC_PORT: z.coerce.number().pipe(z.int().min(1).max(65_535)).default(7071),
  IMP_MCP_SERVICE_TOKEN_FILE: z.string().min(1).optional(),
  IMP_MCP_SERVICE_CLIENTS_FILE: z.string().min(1).optional(),
});

export interface ServiceFiles {
  readonly tokenFile: string;
  readonly clientsFile: string;
}

export interface PublicMcpConfig {
  readonly origin: string;

  readonly host: string;

  readonly port: number;

  // null when impd serves no service clients
  readonly serviceFiles: ServiceFiles | null;
}

// http only on a loopback host, for tests: a front on the internet speaks https
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function parsePublicMcpConfig(
  env: Readonly<z.infer<typeof PublicMcpEnvSchema>>,
  others: readonly (readonly [string, number])[],
  slotPorts: readonly [number, number],
): PublicMcpConfig | null {
  const text = env.IMP_MCP_PUBLIC_URL;
  const serviceFiles = parseServiceFiles(env);

  if (text === undefined) {
    if (serviceFiles !== null) {
      throw new Error(
        'IMP_MCP_SERVICE_TOKEN_FILE and IMP_MCP_SERVICE_CLIENTS_FILE need IMP_MCP_PUBLIC_URL',
      );
    }

    return null;
  }

  const origin = parseOrigin(text);
  const port = env.IMP_MCP_PUBLIC_PORT;
  const clash = others.find(([, other]) => other === port);

  if (clash !== undefined) {
    throw new Error(
      `IMP_MCP_PUBLIC_PORT ${String(port)} is also ${clash[0]}; give it a port of its own`,
    );
  }

  if (port >= slotPorts[0] && port <= slotPorts[1]) {
    throw new Error(
      `IMP_MCP_PUBLIC_PORT ${String(port)} is one of the imps' ports, ${String(slotPorts[0])} to ${String(slotPorts[1])}`,
    );
  }

  return { origin: origin.origin, host: origin.host, port, serviceFiles };
}

function parseServiceFiles(env: Readonly<z.infer<typeof PublicMcpEnvSchema>>): ServiceFiles | null {
  const tokenFile = env.IMP_MCP_SERVICE_TOKEN_FILE;
  const clientsFile = env.IMP_MCP_SERVICE_CLIENTS_FILE;

  if (tokenFile === undefined && clientsFile === undefined) {
    return null;
  }

  if (tokenFile === undefined) {
    throw new Error('IMP_MCP_SERVICE_CLIENTS_FILE needs IMP_MCP_SERVICE_TOKEN_FILE');
  }

  if (clientsFile === undefined) {
    throw new Error('IMP_MCP_SERVICE_TOKEN_FILE needs IMP_MCP_SERVICE_CLIENTS_FILE');
  }

  return { tokenFile, clientsFile };
}

function parseOrigin(text: string): URL {
  let url: URL;

  try {
    url = new URL(text);
  } catch {
    throw new Error(`IMP_MCP_PUBLIC_URL ${text} is not a URL`);
  }

  const isBare =
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    !text.endsWith('/');

  if (!isBare) {
    throw new Error(
      `IMP_MCP_PUBLIC_URL ${text} must be a bare origin, such as https://imp.example.com`,
    );
  }

  const isLoopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error(
      `IMP_MCP_PUBLIC_URL ${text} must be https; http is for a loopback host in tests only`,
    );
  }

  return url;
}
