import type { DevEnv } from './build-dev-layout.ts';
import type { OpReader } from './make-op-reader.ts';
import type { TailscaleAuthkey } from './read-tailscale-authkey.ts';
import { resolveOpRef } from './resolve-op-ref.ts';
import { toEphemeralKey } from './to-ephemeral-key.ts';

interface TailscaleE2EAuthkeyOptions {
  readonly env: DevEnv;
  readonly readOp: OpReader | null;
  readonly warn: (line: string) => void;
}

// Only the tag:imp-e2e OAuth client, never TAILSCALE_AUTHKEY or .env: those may hold a tag:imp key,
// and a tag:imp node reaches a live impd.
export async function readTailscaleE2EAuthkey(
  options: TailscaleE2EAuthkeyOptions,
): Promise<TailscaleAuthkey | null> {
  let secret = options.env['IMP_E2E_TAILSCALE_AUTHKEY'] ?? '';

  if (secret === '' && options.readOp !== null) {
    const ref = resolveOpRef(
      options.env,
      'IMP_E2E_TAILSCALE_OAUTH_REF',
      'imp-e2e-tailscale-oauth/client-secret',
    );

    if (ref.kind === 'missing') {
      options.warn(ref.message);
    } else {
      secret = await options.readOp(ref.ref);
    }
  }

  return secret === '' ? null : { key: toEphemeralKey(secret), tags: 'tag:imp-e2e' };
}
