import { onTestFinished } from 'bun:test';
import { startImpdLogCapture } from './start-impd-log-capture';

export function captureImpdLogs(): string[] {
  const lines: string[] = [];

  onTestFinished(
    startImpdLogCapture((line) => {
      lines.push(line);
    }),
  );

  return lines;
}
