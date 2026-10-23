import { makeOpReader } from '../../scripts/lib/make-op-reader.ts';
import { readTailscaleE2EAuthkey } from '../../scripts/lib/read-tailscale-e2e-authkey.ts';

// Never print the key. Only the tag:imp-e2e OAuth client: dev's tag:imp key
// would join a node that reaches a live impd.
export async function readTailscaleE2EAuthKey(): Promise<{ key: string; tags: string } | null> {
  const authkey = await readTailscaleE2EAuthkey({
    env: process.env,
    readOp: makeOpReader(process.env),
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
