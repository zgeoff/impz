import { appendFileSync } from 'node:fs';
import { config } from './config';

export function writeMetric(key: string, value: unknown): void {
  console.log(`    ${key}: ${JSON.stringify(value)}`);

  if (config.metricsFile !== null) {
    appendFileSync(config.metricsFile, `${JSON.stringify({ [key]: value })}\n`);
  }
}
