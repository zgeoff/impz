import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevEnv } from './build-dev-layout.ts';
import type { OpReader } from './make-op-reader.ts';
import { resolveOpRef } from './resolve-op-ref.ts';
import { toEphemeralKey } from './to-ephemeral-key.ts';

export interface TailscaleAuthkey {
  readonly key: string;
  readonly tags: string | null;
}

interface TailscaleAuthkeyOptions {
  readonly env: DevEnv;
  readonly root: string;
  readonly readOp: OpReader | null;
  readonly warn: (line: string) => void;
}

const CLIENT_SECRET_PREFIX = 'tskey-client-';
const E2E_TAGS = 'tag:imp-e2e';

// The key comes from the env, then 1Password, then the repo's .env. 1Password is asked only with
// IMP_TAILSCALE_OP=1: otherwise every worktree's dev instance would join the tailnet.
export async function readTailscaleAuthkey(
  options: TailscaleAuthkeyOptions,
): Promise<TailscaleAuthkey | null> {
  const env = options.env;
  const fromEnv = env['TAILSCALE_AUTHKEY'] ?? '';

  const tags =
    (env['IMP_TAILSCALE_TAGS'] ?? '') === '' ? null : (env['IMP_TAILSCALE_TAGS'] ?? null);

  if (fromEnv !== '') {
    return { key: fromEnv, tags };
  }

  if (env['IMP_TAILSCALE_OP'] === '1' && options.readOp !== null) {
    const ref = resolveOpRef(
      env,
      'IMP_TAILSCALE_AUTHKEY_REF',
      'imp-e2e-tailscale-oauth/client-secret',
    );

    if (ref.kind === 'missing') {
      options.warn(ref.message);
    } else {
      const secret = await options.readOp(ref.ref);

      // tailscale up takes a client secret as a key only with tags to advertise.
      if (secret.startsWith(CLIENT_SECRET_PREFIX)) {
        return { key: toEphemeralKey(secret), tags: tags ?? E2E_TAGS };
      }

      if (secret !== '') {
        return { key: secret, tags };
      }
    }
  }

  const fromFile = readEnvFileKey(join(options.root, '.env'));

  return fromFile === '' ? null : { key: fromFile, tags };
}

function readEnvFileKey(file: string): string {
  if (!existsSync(file)) {
    return '';
  }

  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('TAILSCALE_AUTHKEY='));

  return (lines.at(-1) ?? '')
    .slice('TAILSCALE_AUTHKEY='.length)
    .replace(/^["']/u, '')
    .replace(/["']$/u, '');
}
