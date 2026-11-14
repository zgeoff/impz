import { mintServiceSecret } from '@zgeoff/mcp-auth';
import { SERVICE_DIGEST_ENV, SERVICE_SECRET_ENV } from './constants.ts';

// The mcp driver reads `secretEnv` from the supervisor's environment, and the supervisor refuses an
// endpoint that holds a secret, so the secret stays in the supervisor and the app gets the digest.
export function createServiceClient(): Readonly<Record<string, string>> {
  const minted = mintServiceSecret();

  process.env[SERVICE_SECRET_ENV] = minted.secret;

  return { [SERVICE_DIGEST_ENV]: minted.digest };
}
