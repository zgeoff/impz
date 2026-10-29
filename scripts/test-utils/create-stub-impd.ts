import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { formatShellWord } from '@impz/test-utils/format-shell-word';
import { match } from 'ts-pattern';
import { buildStubEnvRecord } from './build-stub-env-record';

export interface StubImpdOptions {
  // the lines impd --network-env prints
  readonly networkEnv: readonly string[];

  // variables each run logs after its call line
  readonly recordEnv?: readonly string[];

  // the codes the first runs exit with, in order, before a run takes lastRun
  readonly exitCodes?: readonly number[];

  // stop-entrypoint sends SIGTERM to the entrypoint, the parent that ran it;
  // wait-for-term runs until a SIGTERM reaches it, then logs it and exits 0
  readonly lastRun?: 'stop-entrypoint' | 'wait-for-term';
}

export interface StubImpd {
  readonly bin: string;
  readonly calls: string;
  readonly daemon: string;
  readonly probeRunning: () => boolean;
}

export function createStubImpd(directory: string, options: Readonly<StubImpdOptions>): StubImpd {
  const runs = formatShellWord(join(directory, 'impd-runs'));
  const running = join(directory, 'impd-running');
  const exitCodes = (options.exitCodes ?? []).join(' ');

  // bash runs a trap only once a foreground command ends, but a trapped signal ends the wait
  // builtin at once; the sleep bounds a stub that misses its signal, and holds none of its pipes
  const lastRun = match(options.lastRun ?? 'stop-entrypoint')
    .with('stop-entrypoint', () => 'kill -TERM "$PPID"')
    .with(
      'wait-for-term',
      () => `trap 'kill "$sleeper" 2>/dev/null; echo "impd got TERM" >>"$STUB_CALLS"; exit 0' TERM
command -p sleep 30 </dev/null >/dev/null 2>&1 &
sleeper=$!
touch ${formatShellWord(running)}
wait "$sleeper"`,
    )
    .exhaustive();

  const stub = createStubBin(
    directory,
    'impd',
    `if [ "$1" = --network-env ]; then
  printf '%s\\n' ${options.networkEnv.map((line) => formatShellWord(line)).join(' ')}
  exit 0
fi
${options.recordEnv === undefined ? '' : buildStubEnvRecord(options.recordEnv)}
run=$(command -p cat ${runs} 2>/dev/null || echo 0)
echo $((run + 1)) >${runs}
exit_codes=(${exitCodes})
if [ "$run" -lt "\${#exit_codes[@]}" ]; then exit "\${exit_codes[$run]}"; fi
${lastRun}`,
  );

  return {
    bin: stub.bin,
    calls: stub.calls,
    daemon: join(stub.bin, 'impd'),
    probeRunning: () => existsSync(running),
  };
}
