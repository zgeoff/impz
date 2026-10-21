import type { CommandResult } from '../../src/platform/process/run-command';

export function buildStubMounts() {
  const calls: string[] = [];
  const mounted: string[] = [];

  const busy = new Set<string>();
  const stuck = new Set<string>();
  const kept = new Set<string>();
  const failing = new Map<string, string>();

  const runUmount = (argv: readonly string[]): CommandResult => {
    const target = argv.at(-1) ?? '';
    const isLazy = argv[1] === '--lazy';

    if (!mounted.includes(target)) {
      return { exitCode: 32, stdout: '', stderr: `umount: ${target}: not mounted.\n` };
    }

    if (stuck.has(target) || (busy.has(target) && !isLazy)) {
      return { exitCode: 32, stdout: '', stderr: `umount: ${target}: target is busy.\n` };
    }

    if (!kept.has(target)) {
      mounted.splice(mounted.indexOf(target), 1);
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const runMount = (argv: readonly string[]): CommandResult => {
    const target = argv.at(-1) ?? '';
    const stderr = failing.get(target);

    if (stderr !== undefined) {
      return { exitCode: 32, stdout: '', stderr };
    }

    if (argv[1] === '--bind' || argv[1] === '--rbind') {
      mounted.push(target);
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const run = (argv: readonly string[]): Promise<CommandResult> => {
    calls.push(argv.join(' '));

    const result = argv[0] === 'umount' ? runUmount(argv) : runMount(argv);

    return Promise.resolve(result);
  };

  return {
    calls,
    mounted,
    run,
    readMounts: () =>
      mounted.map((target) => `src ${encodeMountPath(target)} ext4 rw 0 0`).join('\n'),

    addMount: (target: string) => {
      mounted.push(target);
    },
    refusePlainUmount: (target: string) => {
      busy.add(target);
    },
    refuseUmount: (target: string) => {
      stuck.add(target);
    },
    keepAfterUmount: (target: string) => {
      kept.add(target);
    },
    failMount: (target: string, stderr: string) => {
      failing.set(target, stderr);
    },
  };
}

// /proc/self/mounts escapes a space, a tab, a newline and a backslash in octal
function encodeMountPath(path: string): string {
  return path.replaceAll(
    /[ \t\n\\]/gu,
    (char) => `\\${char.codePointAt(0)?.toString(8).padStart(3, '0') ?? ''}`,
  );
}
