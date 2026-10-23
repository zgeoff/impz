import { MCP_PATH } from '@impz/api';
import type { HttpTransport } from '@impz/mcp';
import { Elysia } from 'elysia';
import type { OAuthHandlers } from '../../identity/oauth/create-oauth-handlers';
import { getErrorMessage } from '../../platform/process/get-error-message';

// parse: 'none' leaves each body unread for the handler that reads it.
const RAW = { parse: 'none' } as const;

interface PublicAppDeps {
  readonly oauth: OAuthHandlers | null;
  readonly mcp: Pick<HttpTransport, 'respond'>;
  readonly holdOpen: (request: Request) => void;
  readonly log: (message: string) => void;
}

export function createPublicApp(deps: PublicAppDeps) {
  const app = new Elysia({ strictPath: true })
    .onRequest((context) => {
      // Elysia answers a HEAD on every GET route, and only /mcp takes one here.
      if (context.request.method === 'HEAD' && new URL(context.request.url).pathname !== MCP_PATH) {
        return buildNotFound();
      }

      // Elysia answers the request on any returned value, null included
      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    })
    .onError((context) => {
      if (context.code === 'NOT_FOUND') {
        return buildNotFound();
      }

      deps.log(`impd: public mcp: ${getErrorMessage(context.error)}`);

      return new Response('internal error', { status: 500 });
    })

    // A tool call can run for minutes, so no idle timeout ends it.
    .all(
      MCP_PATH,
      (context) => {
        deps.holdOpen(context.request);

        return deps.mcp.respond(context.request);
      },
      RAW,
    );

  const oauth = deps.oauth;

  if (oauth === null) {
    return app;
  }

  return app
    .get(
      '/.well-known/oauth-authorization-server',
      (context) => oauth.readServerMetadata(context.request),
      RAW,
    )
    .get(
      '/.well-known/oauth-protected-resource',
      (context) => oauth.readResourceMetadata(context.request),
      RAW,
    )
    .get(
      '/.well-known/oauth-protected-resource/mcp',
      (context) => oauth.readResourceMetadata(context.request),
      RAW,
    )
    .get('/error', (context) => oauth.answerError(context.request), RAW)
    .get('/oauth2/authorize', (context) => oauth.runAuthorize(context.request), RAW)
    .post('/oauth2/token', (context) => oauth.runTokenRequest(context.request), RAW)
    .post('/oauth2/revoke', (context) => oauth.runRevoke(context.request), RAW)
    .get('/login', (context) => oauth.runLogin(context.request), RAW)
    .post('/login', (context) => oauth.runLogin(context.request), RAW)
    .get('/consent', (context) => oauth.runConsent(context.request), RAW)
    .post('/consent', (context) => oauth.runConsent(context.request), RAW);
}

function buildNotFound(): Response {
  return new Response('not found', { status: 404 });
}
