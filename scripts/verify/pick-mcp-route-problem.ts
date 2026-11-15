interface MCPRouteAnswers {
  // the status and `WWW-Authenticate` of a POST to `/mcp` with no token
  readonly status: number;
  readonly challenge: string;

  // `grant_types_supported` of the authorization server's metadata
  readonly grants: readonly string[];
}

// Why a service client cannot sign in to the public MCP route, from what the route answered, or null
// when it can: `/mcp` asks for a token and names its resource metadata, and the authorization server
// offers the client_credentials grant, which it does only while impd serves service clients.
export function pickMCPRouteProblem(answers: MCPRouteAnswers): string | null {
  if (answers.status !== 401 || !answers.challenge.includes('resource_metadata=')) {
    return `/mcp answered ${String(answers.status)} to a request with no token, where the public MCP route answers 401 with a resource_metadata challenge`;
  }

  if (!answers.grants.includes('client_credentials')) {
    return `the authorization server offers ${answers.grants.join(', ')} and no client_credentials grant, so impd serves no service clients: it has neither IMP_MCP_SERVICE_TOKEN_FILE nor IMP_MCP_SERVICE_CLIENTS_FILE, or it is older than 7.1.0`;
  }

  return null;
}
