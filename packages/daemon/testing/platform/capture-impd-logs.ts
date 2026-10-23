import { onTestFinished } from 'bun:test';
import { resetSync } from '@logtape/logtape';
import { setupLogging } from '../../src/platform/process/setup-logging';

export function captureImpdLogs(): string[] {
  const lines: string[] = [];

  setupLogging((line) => {
    lines.push(line.replace(/\n$/v, ''));
  });

  onTestFinished(() => {
    resetSync();
  });

  return lines;
}
