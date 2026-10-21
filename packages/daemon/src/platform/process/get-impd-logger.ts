import { getLogger } from '@logtape/logtape';
import type { Logger } from '@logtape/logtape';

export function getImpdLogger(area?: string): Logger {
  const category = area === undefined ? ['impd'] : ['impd', area];

  return getLogger(category);
}
