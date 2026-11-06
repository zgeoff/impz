import type { McpAuth } from '../../identity/oauth/create-mcp-auth';
import { createPublicApp } from '../../surface/oauth/create-public-app';
import { buildStubMcpTransport } from './build-stub-mcp-transport';

export function makeOAuthResponder(
  auth: Pick<McpAuth, 'handlers'>,
): (request: Request) => Promise<Response> {
  const app = createPublicApp({
    oauth: auth.handlers,
    mcp: buildStubMcpTransport(),
    holdOpen: () => {},
  });

  return (request) => app.handle(request);
}
