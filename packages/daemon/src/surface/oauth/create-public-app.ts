import { MCP_PATH } from '@impz/api';
import type { HttpTransport } from '@impz/mcp';
import { getErrorMessage } from '@impz/shared';
import { Elysia, NotFound } from 'elysia';
import type { OAuthHandlers } from '../../identity/oauth/create-oauth-handlers';
import { getImpdLogger } from '../../platform/process/get-impd-logger';

// parse: 'none' leaves each body unread for the handler that reads it.
const RAW = { parse: 'none' } as const;

interface PublicAppDeps {
  readonly oauth: OAuthHandlers | null;
  readonly mcp: Pick<HttpTransport, 'respond'>;
  readonly holdOpen: (request: Request) => void;
}

export function createPublicApp(deps: PublicAppDeps) {
  const app = new Elysia({ strictPath: true })
    .onError((context) => {
      if (context.error instanceof NotFound) {
        return buildNotFound();
      }

      getImpdLogger('public').warning('public mcp: {error}', {
        error: getErrorMessage(context.error),
      });

      return new Response('internal error', { status: 500 });
    })

    // A tool call can run for minutes, so no idle timeout ends it.
    .all(MCP_PATH, RAW, (context) => {
      deps.holdOpen(context.request);

      return deps.mcp.respond(context.request);
    });

  const oauth = deps.oauth;

  if (oauth === null) {
    return app;
  }

  return app
    .get('/.well-known/oauth-authorization-server', RAW, (context) =>
      oauth.readServerMetadata(context.request),
    )
    .get('/.well-known/oauth-protected-resource', RAW, (context) =>
      oauth.readResourceMetadata(context.request),
    )
    .get('/.well-known/oauth-protected-resource/mcp', RAW, (context) =>
      oauth.readResourceMetadata(context.request),
    )
    .get('/error', RAW, (context) => oauth.answerError(context.request))
    .get('/oauth2/authorize', RAW, (context) => oauth.runAuthorize(context.request))
    .post('/oauth2/token', RAW, (context) => oauth.runTokenRequest(context.request))
    .post('/oauth2/revoke', RAW, (context) => oauth.runRevoke(context.request))
    .get('/login', RAW, (context) => oauth.runLogin(context.request))
    .post('/login', RAW, (context) => oauth.runLogin(context.request))
    .get('/consent', RAW, (context) => oauth.runConsent(context.request))
    .post('/consent', RAW, (context) => oauth.runConsent(context.request));
}

function buildNotFound(): Response {
  return new Response('not found', { status: 404 });
}
