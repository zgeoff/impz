import { withContext } from '@logtape/logtape';

export function withImpLogContext<T>(imp: string, run: () => T): T {
  return withContext({ imp }, run);
}
