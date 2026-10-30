import { UsageError } from '../cli/errors';

export function parseBenchLevels(text: string): number[] {
  const levels = text.split(',').map((part) => part.trim());

  if (!levels.every((level) => /^[1-9]\d*$/u.test(level))) {
    throw new UsageError(`--concurrency needs whole numbers above 0, such as 1,4,16, not ${text}`);
  }

  return [...new Set(levels.map(Number))];
}
