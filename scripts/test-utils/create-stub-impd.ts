import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';
import { match } from 'ts-pattern';
import { buildRecordCall } from './build-record-call';

export interface StubImpdOptions {
  // the lines impd --network-env prints
  readonly networkEnv: readonly string[];

  // variables each run records with its call, empty when unset
  readonly recordEnv?: readonly string[];

  // the codes the first runs exit with, in order, before a run takes lastRun
  readonly exitCodes?: readonly number[];

  // stop-entrypoint sends SIGTERM to the entrypoint, the parent that ran it;
  // wait-for-term runs until a SIGTERM reaches it, then notes it and exits 0
  readonly lastRun?: 'stop-entrypoint' | 'wait-for-term';
}

export interface StubImpd {
  readonly daemon: string;
  readonly probeRunning: () => boolean;
  readonly probeTerminated: () => boolean;
}

// A plain bash script, not a kit stand-in, because the entrypoint signals impd and a kit stand-in
// puts a process of its own between them. It records its calls in the folder's calls.jsonl.
export function createStubImpd(directory: string, options: Readonly<StubImpdOptions>): StubImpd {
  const runs = formatShellWord(join(directory, 'impd-runs'));
  const running = join(directory, 'impd-running');
  const terminated = join(directory, 'impd-terminated');
  const exitCodes = (options.exitCodes ?? []).join(' ');

  // bash runs a trap only once a foreground command ends, but a trapped signal ends the wait
  // builtin at once; the sleep bounds a stub that misses its signal, and holds none of its pipes
  const lastRun = match(options.lastRun ?? 'stop-entrypoint')
    .with('stop-entrypoint', () => 'kill -TERM "$PPID"')
    .with(
      'wait-for-term',
      () => `trap 'kill "$sleeper" 2>/dev/null; touch ${formatShellWord(terminated)}; exit 0' TERM
command -p sleep 30 </dev/null >/dev/null 2>&1 &
sleeper=$!
touch ${formatShellWord(running)}
wait "$sleeper"`,
    )
    .exhaustive();

  const callsFile = join(directory, 'calls.jsonl');
  const recordNetworkEnv = buildRecordCall({ name: 'impd', callsFile });
  const recordRun = buildRecordCall({ name: 'impd', callsFile, recordEnv: options.recordEnv });
  const path = join(directory, 'impd');

  writeFileSync(
    path,
    `#!/bin/bash
if [ "$1" = --network-env ]; then
${recordNetworkEnv}
  printf '%s\\n' ${options.networkEnv.map((line) => formatShellWord(line)).join(' ')}
  exit 0
fi
${recordRun}
run=$(command -p cat ${runs} 2>/dev/null || echo 0)
echo $((run + 1)) >${runs}
exit_codes=(${exitCodes})
if [ "$run" -lt "\${#exit_codes[@]}" ]; then exit "\${exit_codes[$run]}"; fi
${lastRun}
`,
  );

  chmodSync(path, 0o755);

  return {
    daemon: path,
    probeRunning: () => existsSync(running),
    probeTerminated: () => existsSync(terminated),
  };
}
