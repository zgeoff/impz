import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestCertificates } from '@impz/test-utils/create-test-certificates';
import * as z from 'zod';
import { createGitFreeEnv, runGitChecked } from './git-env';

const OAUTH_CLIENT_ID = 'e2e-client';

// It never echoes a token, which would put the token in the guest's memory.

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

interface StubOAuth {
  readonly clientId: string;

  readonly firstRefreshToken: string;

  readonly accessTokens: () => readonly string[];
  readonly refreshTokens: () => readonly string[];

  readonly refused: () => number;

  readonly exchange: (refreshToken: string) => number;
}

export interface StubUpstream {
  readonly oauth: StubOAuth;

  readonly origin: string;
  readonly caPem: string;

  readonly plainOrigin: string;
  readonly seen: readonly SeenRequest[];

  readonly createRepo: (path: string) => Promise<string>;

  readonly stop: () => Promise<void>;
}

export async function startStubUpstream(address: string, token: string): Promise<StubUpstream> {
  const directory = mkdtempSync(join(tmpdir(), 'imp-e2e-upstream-'));
  const repos = join(directory, 'repos');
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const bearer = `Bearer ${token}`;
  const seen: SeenRequest[] = [];

  mkdirSync(repos);

  const certificates = await createTestCertificates({ ipAddresses: [address] });

  const oauthState = {
    refreshTokens: [`e2e-refresh-${randomUUID()}`],
    accessTokens: [] as string[],
    refused: 0,
  };

  const runTokenExchange = (refreshToken: string): { status: number; body: unknown } => {
    if (refreshToken !== oauthState.refreshTokens.at(-1)) {
      oauthState.refused += 1;

      return { status: 400, body: { error: 'invalid_grant' } };
    }

    const access = `e2e-access-${randomUUID()}`;
    const refresh = `e2e-refresh-${randomUUID()}`;

    oauthState.accessTokens.push(access);
    oauthState.refreshTokens.push(refresh);

    return {
      status: 200,
      body: { access_token: access, refresh_token: refresh, expires_in: 3600 },
    };
  };

  const handleToken = async (request: Request): Promise<Response> => {
    const payload: unknown = await request.json().catch(() => null);

    const fields = z
      .object({ client_id: z.string(), refresh_token: z.string() })
      .safeParse(payload);

    if (!fields.success || fields.data.client_id !== OAUTH_CLIENT_ID) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }

    const answer = runTokenExchange(fields.data.refresh_token);

    return Response.json(answer.body, { status: answer.status });
  };

  const handleGit = async (request: Request, path: string, query: string): Promise<Response> => {
    if (request.headers.get('authorization') !== expected) {
      return new Response('auth needed\n', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="fake"' },
      });
    }

    const received = await request.arrayBuffer();

    const body = new Uint8Array(received);

    const child = Bun.spawn(['git', 'http-backend'], {
      stdin: body,
      stdout: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        GIT_PROJECT_ROOT: repos,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'x-access-token',
        REQUEST_METHOD: request.method,
        PATH_INFO: path,
        QUERY_STRING: query,
        CONTENT_TYPE: request.headers.get('content-type') ?? '',
        HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
      },
    });

    const output = await new Response(child.stdout).arrayBuffer();

    await child.exited;

    return parseCgiOutput(new Uint8Array(output));
  };

  const readRequest = (request: Request): Promise<Response> | Response => {
    const url = new URL(request.url);

    seen.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
    });

    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      return handleToken(request);
    }

    if (url.pathname === '/oauth-e2e/me') {
      const current = oauthState.accessTokens.at(-1);

      return Response.json({
        generation: oauthState.accessTokens.length,
        authorized:
          current !== undefined && request.headers.get('authorization') === `Bearer ${current}`,
      });
    }

    if (url.pathname.includes('.git/')) {
      return handleGit(request, url.pathname, url.search.slice(1));
    }

    return Response.json({ authorized: request.headers.get('authorization') === bearer });
  };

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    tls: {
      cert: certificates.certPem,
      key: certificates.keyPem,
    },
    maxRequestBodySize: 256 * 1024 ** 2,
    idleTimeout: 60,
    fetch: readRequest,
  });

  const plainServer = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: readRequest });

  return {
    oauth: {
      clientId: OAUTH_CLIENT_ID,
      firstRefreshToken: oauthState.refreshTokens[0] ?? '',
      accessTokens: () => [...oauthState.accessTokens],
      refreshTokens: () => [...oauthState.refreshTokens],
      refused: () => oauthState.refused,
      exchange: (refreshToken) => runTokenExchange(refreshToken).status,
    },
    origin: `https://${address}:${String(server.port)}`,
    caPem: certificates.caPem,
    plainOrigin: `http://${address}:${String(plainServer.port)}`,
    seen,
    createRepo: async (path) => {
      const repo = join(repos, path);

      await runGitChecked(['git', 'init', '-q', '--bare', '-b', 'main', repo]);
      await runGitChecked(['git', '-C', repo, 'config', 'http.receivepack', 'true']);

      return repo;
    },
    stop: async () => {
      await server.stop(true);
      await plainServer.stop(true);

      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const CGI_HEADER_END = /\r?\n\r?\n/u;

function parseCgiOutput(output: Uint8Array): Response {
  const text = Buffer.from(output).toString('latin1');
  const match = CGI_HEADER_END.exec(text);
  const headEnd = match?.index ?? text.length;
  const bodyStart = headEnd + (match?.[0].length ?? 0);

  const headers = new Headers();

  let status = 200;

  for (const line of text.slice(0, headEnd).split(/\r?\n/u)) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();

    if (name.toLowerCase() === 'status') {
      status = Number(value.split(' ')[0]);
    } else if (name !== '') {
      headers.set(name, value);
    }
  }

  return new Response(output.subarray(bodyStart), { status, headers });
}
