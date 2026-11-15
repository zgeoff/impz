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

// The targets that `up` starts, whose app is this checkout's impd, run with impd's root token.
export const LAUNCH_TARGETS: readonly string[] = ['local', 'local-kvm'];

// The read client of the deployed impd, which holds only the `read` scope, so impd refuses any
// write that the read-only target's fence misses. The deployment's public MCP origin comes from the
// environment of the shell that runs `attach`, beside the secret, so the repo names no deployment.
export const PROD_CLIENT_NAME = 'wringer-ro';
export const PROD_CLIENT_SCOPE = 'read';
export const PROD_SECRET_ENV = 'IMPZ_VERIFY_PROD_SECRET';
export const PROD_ORIGIN_ENV = 'IMPZ_VERIFY_PROD_ORIGIN';

// The MCP tools of the `read` scope, which a read-only target may call. `imp_read_file` reads, but
// needs the `exec` scope and wakes the imp.
export const READ_TOOLS: readonly string[] = [
  'imp_list',
  'imp_image_list',
  'imp_event_list',
  'imp_checkpoint_list',
  'imp_url',
];

// The image every journey boots, built from the e2e fixture of the same name on a KVM host.
export const IMAGE_NAME = 'tiny';
