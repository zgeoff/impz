import { join } from 'node:path';
import * as z from 'zod';

const PrefixSchema = z
  .string()
  .regex(
    /^[a-z][a-z\d-]{0,20}$/u,
    'IMP_TAILNET_NAME_PREFIX must be a lowercase letter followed by up to 20 letters, digits or hyphens',
  );

export const TailnetNamesEnvSchema = z.object({
  IMP_TAILNET_NAMES: z.literal('1').optional(),
  IMP_TAILNET_NAME_PREFIX: PrefixSchema.optional(),
  IMP_TAILNET_OAUTH_FILE: z.string().optional(),
});

export interface TailnetNamesConfig {
  readonly prefix: string;

  readonly oauthFile: string;
}

export function parseTailnetNamesConfig(
  env: z.infer<typeof TailnetNamesEnvSchema>,
  dataDir: string,
  isOnTailnet: boolean,
): TailnetNamesConfig | null {
  if (env.IMP_TAILNET_NAMES === undefined) {
    return null;
  }

  if (!isOnTailnet) {
    throw new Error(
      'IMP_TAILNET_NAMES=1 needs the host on the tailnet (TAILSCALE_AUTHKEY or IMP_TAILSCALE_NODE=1)',
    );
  }

  return {
    prefix: env.IMP_TAILNET_NAME_PREFIX ?? '',
    oauthFile: env.IMP_TAILNET_OAUTH_FILE ?? join(dataDir, 'tailnet-names', 'oauth.json'),
  };
}
