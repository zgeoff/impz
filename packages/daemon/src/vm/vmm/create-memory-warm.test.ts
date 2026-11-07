import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import { runCommand } from '../../platform/process/run-command';
import { captureImpdLogs } from '../../test-utils/platform/capture-impd-logs';
import { probeProcessRunning } from '../../test-utils/platform/probe-process-running';
import { createStubUffdHandler } from '../../test-utils/vm/create-stub-uffd-handler';
import { createMemoryWarm } from './create-memory-warm';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'memory-warm-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const logs = captureImpdLogs();
  const handler = createStubUffdHandler(directory);
  const warm = createMemoryWarm({ handlerBin: handler.path, capMib: 256, run: runCommand });

  onTestFinished(() => warm.stopAll());

  return { directoryPath: directory, logs, handler, warm };
}

test('it warms a memory file whose data fills the cap, and logs its time and blocks', async () => {
  const ctx = setupTest();
  const memFile = join(ctx.directoryPath, 'mem');

  ctx.handler.answerWarm({ blocks: 128 });
  ctx.warm.start({ impId: 'imp-1', name: 'dev', memFile });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      /^INFO impd\.imps imp=dev warmed the memory file in \d+ms: 128 blocks of 2 MiB$/u.test(line),
    );
  });

  expect(ctx.handler.readWarmRuns().map((run) => [run.mode, run.memFile])).toStrictEqual([
    ['--count-data', memFile],
    ['--warm', memFile],
  ]);
});

test('it leaves cold a memory file whose data passes the cap, and logs its size', async () => {
  const ctx = setupTest();

  ctx.handler.answerWarm({ blocks: 129 });
  ctx.warm.start({ impId: 'imp-1', name: 'dev', memFile: join(ctx.directoryPath, 'mem') });

  await waitFor(() => {
    expect(ctx.logs).toContain(
      'INFO impd.imps imp=dev left the memory file cold: its 258 MiB of data pass the warm cap of 256 MiB',
    );
  });

  expect(ctx.handler.readWarmRuns().map((run) => run.mode)).toStrictEqual(['--count-data']);
});

test('it ends a running warm at a stop, and logs why', async () => {
  const ctx = setupTest();

  ctx.handler.answerWarm({ blocks: 64, hangs: true });
  ctx.warm.start({ impId: 'imp-1', name: 'dev', memFile: join(ctx.directoryPath, 'mem') });

  await waitFor(() => {
    expect(ctx.handler.readWarmRuns()).toHaveLength(2);
  });

  await ctx.warm.stop('imp-1', 'woke');

  expect(probeProcessRunning(ctx.handler.readWarmRuns()[1]?.pid ?? 0)).toBeFalse();

  expect(ctx.logs).toSatisfyAny((line: string) =>
    /^INFO impd\.imps imp=dev stopped the memory file's warm after \d+ms: the imp woke$/u.test(
      line,
    ),
  );
});

test('it ends every running warm at impd stop', async () => {
  const ctx = setupTest();

  ctx.handler.answerWarm({ blocks: 64, hangs: true });
  ctx.warm.start({ impId: 'imp-1', name: 'dev', memFile: join(ctx.directoryPath, 'mem') });

  await waitFor(() => {
    expect(ctx.handler.readWarmRuns()).toHaveLength(2);
  });

  await ctx.warm.stopAll();

  expect(ctx.logs).toSatisfyAny((line: string) =>
    /^INFO impd\.imps imp=dev stopped the memory file's warm after \d+ms: impd stopped$/u.test(
      line,
    ),
  );
});

test('it logs a warning when the page handler cannot run', async () => {
  const ctx = setupTest();

  const warm = createMemoryWarm({
    handlerBin: join(ctx.directoryPath, 'no-handler'),
    capMib: 256,
    run: runCommand,
  });

  warm.start({ impId: 'imp-1', name: 'dev', memFile: join(ctx.directoryPath, 'mem') });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      line.startsWith("WARNING impd.imps imp=dev the memory file's warm failed: "),
    );
  });
});
