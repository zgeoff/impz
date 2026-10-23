import { ImpdError } from '../../platform/errors/impd-error';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { buildExitError, runCommand } from '../../platform/process/run-command';
import type { CommandResult } from '../../platform/process/run-command';
import { readProxyRefusal } from '../docker-contract/refusal';

interface DockerOptions {
  readonly env?: Readonly<Record<string, string>> | undefined;

  readonly signal?: AbortSignal;
}

export async function runDocker(
  argv: readonly string[],
  options: DockerOptions = {},
): Promise<CommandResult> {
  const result = await runCommand(['docker', ...argv], {
    ...(options.env !== undefined && { env: options.env }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  if (result.exitCode !== 0) {
    const refused = readRefusalError(`docker ${argv[0] ?? ''}`, result.stderr);

    if (refused !== null) {
      throw refused;
    }
  }

  return result;
}

function readRefusalError(call: string, output: string): ImpdError | null {
  const refusal = readProxyRefusal(output);

  if (refusal === null) {
    return null;
  }

  getImpdLogger('image').warning('{call} refused: {refusal}', { call, refusal });

  return new ImpdError('BAD_REQUEST', { message: refusal });
}

export async function runDockerChecked(
  argv: readonly string[],
  options: DockerOptions = {},
): Promise<string> {
  const result = await runDocker(argv, options);

  if (result.exitCode !== 0) {
    throw buildExitError(['docker', ...argv], result);
  }

  return result.stdout;
}
