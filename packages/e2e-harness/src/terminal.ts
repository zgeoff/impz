import { join } from 'node:path';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT } from './instance';
import { waitFor } from './wait-for';

export interface Terminal {
  readonly type: (text: string) => void;

  readonly resize: (cols: number, rows: number) => void;

  readonly waitForText: (text: string, since?: number) => Promise<void>;

  readonly readOutput: () => string;
  readonly exited: Promise<number>;

  readonly close: () => Promise<void>;
}

const DEFAULT_SIZE = { cols: 80, rows: 24 } as const;

export async function openTerminal(
  args: readonly string[],
  size?: Readonly<{ cols: number; rows: number }>,
): Promise<Terminal> {
  const impEnv = await readImpEnv();

  return openCommandTerminal([join(REPO_ROOT, 'scripts', 'impz'), ...args], impEnv, size);
}

export function openCommandTerminal(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
  size?: Readonly<{ cols: number; rows: number }>,
): Terminal {
  const decoder = new TextDecoder();

  const shown = { text: '' };

  const subprocess = Bun.spawn([...argv], {
    env: { ...process.env, ...env },
    terminal: {
      ...(size ?? DEFAULT_SIZE),
      data: (_terminal, data) => {
        shown.text += decoder.decode(data, { stream: true });
      },
    },
  });

  const readOutput = (): string => shown.text.replaceAll('\r', '');

  const exited = (async () => {
    const code = await subprocess.exited;

    subprocess.terminal?.close();

    return code;
  })();

  return {
    type: (text) => {
      subprocess.terminal?.write(text);
    },
    resize: (cols, rows) => {
      subprocess.terminal?.resize(cols, rows);
    },
    waitForText: (text, since = 0) =>
      waitFor(
        `the terminal to show ${JSON.stringify(text)}`,
        () => {
          if (!readOutput().slice(since).includes(text)) {
            throw new Error(`not yet; last: ${JSON.stringify(readOutput().slice(-200))}`);
          }
        },
        { intervalMs: 50, timeoutMs: 30_000 },
      ),
    readOutput,
    exited,
    close: async () => {
      subprocess.kill();

      await exited;
    },
  };
}
