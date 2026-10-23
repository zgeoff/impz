import { $ } from 'bun';
import { DevError } from '../lib/dev-error.ts';
import { StopError } from './stop-error.ts';
import type { ZfsIO } from './types.ts';

// The exit code a failed step gives the run, as bash's set -e gives a failed command's own code.
export function reportZfsError(
  io: Pick<ZfsIO, 'writeStderr'>,
  prefix: string,
  error: unknown,
): number {
  if (error instanceof StopError) {
    return error.exitCode;
  }

  // The command streamed its own stderr.
  if (error instanceof $.ShellError) {
    return error.exitCode;
  }

  if (error instanceof DevError) {
    io.writeStderr(`${prefix}: ${error.message}\n${error.detail}`);

    return 1;
  }

  io.writeStderr(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);

  return 1;
}
