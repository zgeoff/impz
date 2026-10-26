import { join } from 'node:path';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT } from './instance';
import { waitFor } from './wait-for';

export interface ConsoleStep {
  // Text a shell computes, such as console-$((40 + 2)) printing console-42,
  // never matches the echo of the typed line.
  readonly after: string | null;
  readonly line: string;
}

export async function runConsole(
  name: string,
  steps: readonly ConsoleStep[],
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const impEnv = await readImpEnv();

  const decoder = new TextDecoder();

  let output = '';

  const subprocess = Bun.spawn([join(REPO_ROOT, 'scripts', 'impz'), 'console', name], {
    env: { ...process.env, ...impEnv },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
    },
  });

  const checkShown = (text: string) => {
    if (!output.includes(text)) {
      throw new Error(`it shows ${JSON.stringify(output.slice(-200))}`);
    }
  };

  for (const step of steps) {
    const after = step.after;

    if (after !== null) {
      await waitFor(
        `the console of ${name} to show ${after}`,
        () => {
          checkShown(after);
        },
        {
          intervalMs: 50,
          timeoutMs: 30_000,
        },
      );
    }

    subprocess.terminal?.write(`${step.line}\n`);
  }

  const exitCode = await subprocess.exited;

  subprocess.terminal?.close();

  return { exitCode, output: output.replaceAll('\r', '') };
}
