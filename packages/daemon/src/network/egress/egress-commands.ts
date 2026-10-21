import { buildExitError, runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';

export async function runForwardRulesList(run: CommandRunner = runCommand): Promise<string> {
  const argv = ['iptables', '-S', 'FORWARD'];

  const result = await run(argv);

  if (result.exitCode !== 0) {
    throw buildExitError(argv, { exitCode: result.exitCode, stderr: result.stderr });
  }

  return result.stdout;
}

export async function runPairFlush(
  first: string,
  second: string,
  run: CommandRunner = runCommand,
): Promise<void> {
  // both directions: conntrack matches -s and -d on a flow's original tuple
  for (const [source, destination] of [
    [first, second],
    [second, first],
  ] as const) {
    const argv = ['conntrack', '-D', '-s', source, '-d', destination];

    const result = await run(argv);

    if (result.exitCode !== 0 && !result.stderr.includes('0 flow entries')) {
      throw buildExitError(argv, { exitCode: result.exitCode, stderr: result.stderr });
    }
  }
}

export async function runConntrackFlush(
  guestIp: string,
  run: CommandRunner = runCommand,
): Promise<void> {
  const argv = ['conntrack', '-D', '-s', guestIp];

  const result = await run(argv);

  // `conntrack -D` exits 1 when it found nothing to delete
  if (result.exitCode !== 0 && !result.stderr.includes('0 flow entries')) {
    throw buildExitError(argv, { exitCode: result.exitCode, stderr: result.stderr });
  }
}
