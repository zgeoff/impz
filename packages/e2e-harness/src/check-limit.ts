import { config } from './config';

export function checkLimit(what: string, durationMs: number, limitMs: number): void {
  if (durationMs <= limitMs) {
    return;
  }

  const message = `${what} took ${String(durationMs)} ms, over the ${String(limitMs)} ms limit`;

  if (config.acceptance) {
    throw new Error(message);
  }

  console.log(`    warning: ${message}`);
}
