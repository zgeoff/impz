import type { Imp } from '@impz/api';
import { formatImps } from './format-imps';

export function formatImp(imp: Imp): string {
  return formatImps([imp]);
}
