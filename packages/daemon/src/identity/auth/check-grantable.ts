import { SecretNameSchema } from '@impz/api';
import { formatCaller } from '../../platform/principal/caller';
import type { Caller } from '../../platform/principal/caller';
import type { ReadSecretGeneration, Refusal } from './access-policy';

export async function checkGrantable(
  caller: Readonly<Caller>,
  secret: string | null,
  readSecretGeneration: ReadSecretGeneration,
): Promise<Refusal | null> {
  const entry = secret === null ? undefined : caller.grantable.find((each) => each.name === secret);
  const current = entry === undefined ? null : await readSecretGeneration(entry.name);

  if (entry !== undefined && current === entry.generation) {
    return null;
  }

  // the input is not checked yet: it is named only when it has a name's form
  const named = SecretNameSchema.safeParse(secret);
  const what = named.success ? `secret ${named.data}` : 'that secret';

  return {
    message: `${formatCaller(caller)} may not grant or revoke ${what}`,
    reason: 'not_grantable',
  };
}
