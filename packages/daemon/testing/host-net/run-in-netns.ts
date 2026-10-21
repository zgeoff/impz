import { buildUnshare } from './build-unshare';

interface RunInNetnsOptions {
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;

  // `ip netns` needs a writable /run, which a mount namespace lets the script
  // mount as a tmpfs.
  readonly mount: boolean;
}

export interface NetnsRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export function runInNetns(options: RunInNetnsOptions): NetnsRun {
  const unshare = buildUnshare({ mount: options.mount, uid: process.getuid?.() });

  const result = Bun.spawnSync([...unshare, 'bash', '-euo', 'pipefail', '-c', options.script], {
    env: { ...process.env, ...options.env },
  });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}
