import { readFileSync, statSync } from 'node:fs';
import * as z from 'zod';

const CredentialSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

export type OAuthCredential = z.infer<typeof CredentialSchema>;

export function readOAuthCredential(path: string): OAuthCredential {
  const mode = statSync(path).mode & 0o777;

  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} is mode ${mode.toString(8)}; it holds a secret, so make it 0600`);
  }

  const parsed = CredentialSchema.safeParse(readJson(path));

  if (!parsed.success) {
    throw new Error(`${path} must be JSON with a clientId and a clientSecret`);
  }

  return parsed.data;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
