import { runChecked } from '../../src/platform/process/run-command';
import type { CommandResult } from '../../src/platform/process/run-command';

interface StubIpCommandOptions {
  readonly failures?: Readonly<Record<string, string>>;
  readonly sysctls?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
}

const CHANGES = [
  'ip tuntap add ',
  'ip link set ',
  'ip link del ',
  'ip addr add ',
  'ip -6 route replace ',
];

export function buildStubIpCommand(options: Readonly<StubIpCommandOptions> = {}) {
  const calls: string[] = [];

  const sysctls = new Map(Object.entries(options.sysctls ?? {}));

  const readSysctl = (key: string): CommandResult => {
    const value = sysctls.get(key);

    return value === undefined
      ? buildMissingKeyResult(key)
      : { exitCode: 0, stdout: `${value}\n`, stderr: '' };
  };

  const writeSysctl = (assignment: string): CommandResult => {
    const [key = '', value = ''] = assignment.split('=');

    if (!sysctls.has(key)) {
      return buildMissingKeyResult(key);
    }

    sysctls.set(key, value);

    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const runLine = (argv: readonly string[], line: string): CommandResult => {
    const failure = Object.entries(options.failures ?? {}).find(([prefix]) =>
      line.startsWith(prefix),
    );

    if (failure !== undefined) {
      return { exitCode: 2, stdout: '', stderr: `${failure[1]}\n` };
    }

    if (argv.length === 3 && argv[0] === 'sysctl' && argv[1] === '-n') {
      return readSysctl(argv[2] ?? '');
    }

    if (argv.length === 3 && argv[0] === 'sysctl' && argv[1] === '-qw') {
      return writeSysctl(argv[2] ?? '');
    }

    if (CHANGES.some((change) => line.startsWith(change))) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const output = options.outputs?.[line];

    if (output === undefined) {
      throw new Error(`stub ip: no model for ${line}`);
    }

    return { exitCode: 0, stdout: output, stderr: '' };
  };

  const run = async (argv: readonly string[]): Promise<CommandResult> => {
    const line = argv.join(' ');

    calls.push(line);

    await Promise.resolve();

    return runLine(argv, line);
  };

  return {
    calls,
    run,
    runChecked: (argv: readonly string[]): Promise<string> => runChecked(argv, {}, run),
    readSysctl: (key: string): string | undefined => sysctls.get(key),
  };
}

function buildMissingKeyResult(key: string): CommandResult {
  return {
    exitCode: 255,
    stdout: '',
    stderr: `sysctl: cannot stat /proc/sys/${key.replaceAll('.', '/')}: No such file or directory\n`,
  };
}
