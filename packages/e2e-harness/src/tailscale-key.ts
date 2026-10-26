import { makeOpReader } from '../../../scripts/lib/make-op-reader.ts';
import { readTailscaleE2EAuthkey } from '../../../scripts/lib/read-tailscale-e2e-authkey.ts';
import type { HarnessEnv } from './config';

export interface TailscaleE2EKey {
  readonly key: string;
  readonly tags: string;
}

// Never print the key. Only the test tailnet's OAuth client: dev's key would
// join a node to the production tailnet, where a live impd runs.
export async function readTailscaleE2EAuthKey(env: HarnessEnv): Promise<TailscaleE2EKey | null> {
  const authkey = await readTailscaleE2EAuthkey({
    env,
    readOp: makeOpReader(env),
    warn: (line) => {
      console.error(line);
    },
  });

  return authkey === null ? null : { key: authkey.key, tags: authkey.tags ?? '' };
}

export function probeTailscaleE2EKey(): boolean {
  return (
    (process.env['TAILSCALE_AUTHKEY'] ?? '') !== '' &&
    process.env['IMP_TAILSCALE_TAGS'] === 'tag:imp-e2e'
  );
}
