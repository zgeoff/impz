// The service client each run mints. Its entry in the clients file reaches only `wv-mcp-*`, so a
// journey can name an imp it must refuse `wv-` too.
export const SERVICE_CLIENT_NAME = 'wringer-verify';
export const SERVICE_CLIENT_IMPS: readonly string[] = ['wv-mcp-*'];
export const SERVICE_CLIENT_SCOPE = 'manage';

// The MCP SDK asks for every scope the route's resource metadata lists, before the scope a target
// sets, so the token file grants all three; impd acts with the highest.
export const SERVICE_CLIENT_SCOPES: readonly string[] = ['read', 'exec', 'manage'];

// The supervisor reads the secret from its own environment; the app gets only the digest.
export const SERVICE_SECRET_ENV = 'IMPZ_VERIFY_SERVICE_SECRET';
export const SERVICE_DIGEST_ENV = 'IMPZ_VERIFY_SERVICE_DIGEST';
export const RUN_DIRECTORY_ENV = 'IMPZ_VERIFY_RUN_DIRECTORY';

// The image every journey boots, built from the e2e fixture of the same name on a KVM host.
export const IMAGE_NAME = 'tiny';
