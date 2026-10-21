import { AsyncLocalStorage } from 'node:async_hooks';
import { configureSync } from '@logtape/logtape';
import type { LogRecord } from '@logtape/logtape';

export function setupLogging(write: (line: string) => void = writeStdout): void {
  configureSync({
    reset: true,
    sinks: {
      lines: (record) => {
        write(renderLogLine(record));
      },
    },
    loggers: [
      { category: ['impd'], sinks: ['lines'], lowestLevel: 'debug' },

      // LogTape logs its own trouble, such as a sink that throws, under this category
      { category: ['logtape', 'meta'], sinks: ['lines'], lowestLevel: 'warning' },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  });
}

function writeStdout(line: string): void {
  process.stdout.write(line);
}

interface RenderedRecord {
  readonly level: LogRecord['level'];
  readonly category: readonly string[];
  readonly message: readonly unknown[];
  readonly properties: Readonly<Record<string, unknown>>;
}

function renderLogLine(record: RenderedRecord): string {
  const imp = record.properties['imp'];
  const about = typeof imp === 'string' ? `imp=${imp} ` : '';

  const message = record.message
    .map((part) => (typeof part === 'string' ? part : Bun.inspect(part)))
    .join('')
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('\n', String.raw`\n`);

  return `${record.level.toUpperCase()} ${record.category.join('.')} ${about}${message}\n`;
}
