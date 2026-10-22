import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DevEnv } from './build-dev-layout.ts';
import type { OpReader } from './make-op-reader.ts';
import { resolveOpRef } from './resolve-op-ref.ts';

interface TailnetOAuthFileOptions {
  readonly file: string;
  readonly env: DevEnv;
  readonly readOp: OpReader | null;
  readonly warn: (line: string) => void;
}

export async function writeTailnetOAuthFile(options: TailnetOAuthFileOptions): Promise<boolean> {
  if (options.readOp === null) {
    return false;
  }

  const ref = resolveOpRef(options.env, 'IMP_TAILNET_OAUTH_REF', 'imp-e2e-tailscale-services');

  if (ref.kind === 'missing') {
    options.warn(ref.message);

    return false;
  }

  const clientID = await options.readOp(`${ref.ref}/client-id`);

  if (clientID === '') {
    return false;
  }

  const clientSecret = await options.readOp(`${ref.ref}/client-secret`);

  if (clientSecret === '') {
    return false;
  }

  mkdirSync(dirname(options.file), { recursive: true });

  writeFileSync(
    options.file,
    `${JSON.stringify({ clientId: clientID, clientSecret }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );

  chmodSync(options.file, 0o600);

  return true;
}
