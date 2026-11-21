import { onTestFinished } from 'bun:test';
import { startImpdLogCapture } from '@impz/testing/stand-in/platform/start-impd-log-capture';

export function captureImpdLogs(): string[] {
  const lines: string[] = [];

  onTestFinished(
    startImpdLogCapture((line) => {
      lines.push(line);
    }),
  );

  return lines;
}
