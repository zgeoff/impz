import * as z from 'zod';
import { PLAIN_WORD } from './plain-word.ts';

export const ZFS_POOL_FILE = 'deploy/zfs-pool.json';

// zpool create's words go unquoted into storage.sh, so each one is a plain word.
const ZfsPoolSchema = z.object({
  create: z
    .array(z.string().regex(PLAIN_WORD, { error: 'is not a plain word' }))
    .nonempty({ error: 'gives zpool create no properties' }),
});

export function parseZfsPoolProperties(json: string): readonly string[] {
  const parsed = ZfsPoolSchema.safeParse(parseJSON(json));

  if (!parsed.success) {
    throw new Error(`${ZFS_POOL_FILE}: ${z.prettifyError(parsed.error)}`);
  }

  return parsed.data.create;
}

function parseJSON(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`${ZFS_POOL_FILE}: ${message}`, { cause: error });
  }
}
