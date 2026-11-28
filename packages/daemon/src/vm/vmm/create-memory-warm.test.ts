import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubUffdHandler } from '@impz/testing/stand-in/vm/create-stub-uffd-handler';
import { waitFor } from '@zgeoff/testing';
import { runCommand } from '../../platform/process/run-command';
import { captureImpdLogs } from '../../test-utils/platform/capture-impd-logs';
import { probeProcessRunning } from '../../test-utils/platform/probe-process-running';
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

  // the file the handler leaves for a wake that served the given number of
  // blocks, in block order: a uint32 per block, its first-fault ordinal
  const writeRecord = (blocks: number): string => {
    const path = join(directory, 'mem.touched');
    const raw = Buffer.alloc(blocks * 4);

    for (let block = 0; block < blocks; block += 1) {
      raw.writeUInt32LE(block + 1, block * 4);
    }

    writeFileSync(path, raw);

    return path;
  };

  return { directoryPath: directory, logs, handler, warm, writeRecord };
}

test('it warms a memory file whose data fills the cap, and logs its time and blocks', async () => {
  const ctx = setupTest();
  const memFile = join(ctx.directoryPath, 'mem');

  ctx.handler.answerWarm({ blocks: 128 });

  ctx.warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile,
    blockList: join(ctx.directoryPath, 'mem.touched'),
  });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      /^INFO impd\.imps imp=dev warmed the whole memory file in \d+ms: 128 blocks of 2 MiB$/u.test(
        line,
      ),
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

  ctx.warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile: join(ctx.directoryPath, 'mem'),
    blockList: join(ctx.directoryPath, 'mem.touched'),
  });

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

  ctx.warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile: join(ctx.directoryPath, 'mem'),
    blockList: join(ctx.directoryPath, 'mem.touched'),
  });

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

test('it ends a warm that waits for a slot at once, and starts no handler for it', async () => {
  const ctx = setupTest();

  ctx.handler.answerWarm({ blocks: 64, hangs: true });

  ctx.warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile: join(ctx.directoryPath, 'mem-1'),
    blockList: join(ctx.directoryPath, 'mem-1.touched'),
  });

  ctx.warm.start({
    impID: 'imp-2',
    name: 'web',
    memFile: join(ctx.directoryPath, 'mem-2'),
    blockList: join(ctx.directoryPath, 'mem-2.touched'),
  });

  await waitFor(() => {
    expect(ctx.handler.readWarmRuns().filter((run) => run.mode === '--warm')).toHaveLength(2);
  });

  ctx.warm.start({
    impID: 'imp-3',
    name: 'docs',
    memFile: join(ctx.directoryPath, 'mem-3'),
    blockList: join(ctx.directoryPath, 'mem-3.touched'),
  });

  await ctx.warm.stop('imp-3', 'woke');

  expect(ctx.logs).toSatisfyAny((line: string) =>
    /^INFO impd\.imps imp=docs stopped the memory file's warm after \d+ms: the imp woke$/u.test(
      line,
    ),
  );

  await ctx.warm.stopAll();

  expect(ctx.handler.readWarmRuns().map((run) => run.memFile)).not.toContain(
    join(ctx.directoryPath, 'mem-3'),
  );
});

test('it ends every running warm at impd stop', async () => {
  const ctx = setupTest();

  ctx.handler.answerWarm({ blocks: 64, hangs: true });

  ctx.warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile: join(ctx.directoryPath, 'mem'),
    blockList: join(ctx.directoryPath, 'mem.touched'),
  });

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

test('it starts no warm for a sleep that ends after impd stop, and logs why', async () => {
  const ctx = setupTest();

  await ctx.warm.stopAll();

  ctx.warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile: join(ctx.directoryPath, 'mem'),
    blockList: join(ctx.directoryPath, 'mem.touched'),
  });

  await ctx.warm.stopAll();

  expect(ctx.handler.readWarmRuns()).toStrictEqual([]);
  expect(ctx.logs).toContain('INFO impd.imps imp=dev left the memory file cold: impd is stopping');
});

test('it logs a warning when the page handler cannot run', async () => {
  const ctx = setupTest();

  const warm = createMemoryWarm({
    handlerBin: join(ctx.directoryPath, 'no-handler'),
    capMib: 256,
    run: runCommand,
  });

  warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile: join(ctx.directoryPath, 'mem'),
    blockList: join(ctx.directoryPath, 'mem.touched'),
  });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      line.startsWith("WARNING impd.imps imp=dev the memory file's warm failed: "),
    );
  });
});

test('it warms only the recorded blocks, and logs their count', async () => {
  const ctx = setupTest();
  const memFile = join(ctx.directoryPath, 'mem');
  const blockList = join(ctx.directoryPath, 'mem.touched');

  ctx.writeRecord(64);
  ctx.warm.start({ impID: 'imp-1', name: 'dev', memFile, blockList });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      /^INFO impd\.imps imp=dev warmed 64 of 64 recorded blocks \(128 of 128 MiB\) in \d+ms$/u.test(
        line,
      ),
    );
  });

  expect(
    ctx.handler.readWarmRuns().map((run) => [run.mode, run.blockList, run.memFile, run.limit]),
  ).toStrictEqual([
    ['--count-blocks', blockList, memFile, undefined],
    ['--warm-blocks', blockList, memFile, 128],
  ]);
});

test('it warms the first blocks of a recorded set that passes the cap, and logs how many', async () => {
  const ctx = setupTest();
  const memFile = join(ctx.directoryPath, 'mem');
  const blockList = join(ctx.directoryPath, 'mem.touched');

  ctx.writeRecord(245);
  ctx.warm.start({ impID: 'imp-1', name: 'dev', memFile, blockList });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      /^INFO impd\.imps imp=dev warmed 128 of 245 recorded blocks \(256 of 490 MiB\) in \d+ms$/u.test(
        line,
      ),
    );
  });

  expect(ctx.handler.readWarmRuns().map((run) => [run.mode, run.limit])).toStrictEqual([
    ['--count-blocks', undefined],
    ['--warm-blocks', 128],
  ]);
});

test('it leaves cold a recorded set when not one block fits the cap', async () => {
  const ctx = setupTest();
  const blockList = join(ctx.directoryPath, 'mem.touched');

  ctx.writeRecord(3);

  const warm = createMemoryWarm({
    handlerBin: ctx.handler.path,
    capMib: 1,
    run: runCommand,
  });

  onTestFinished(() => warm.stopAll());

  warm.start({
    impID: 'imp-1',
    name: 'dev',
    memFile: join(ctx.directoryPath, 'mem'),
    blockList,
  });

  await waitFor(() => {
    expect(ctx.logs).toContain(
      'INFO impd.imps imp=dev left the memory file cold: not one of its 3 recorded blocks of 2 MiB fits the warm cap of 1 MiB',
    );
  });

  expect(ctx.handler.readWarmRuns().map((run) => run.mode)).toStrictEqual(['--count-blocks']);
});

test('it counts the whole file when the handler refuses a record of one byte per block', async () => {
  const ctx = setupTest();
  const memFile = join(ctx.directoryPath, 'mem');
  const blockList = join(ctx.directoryPath, 'mem.touched');

  // the record that impd 7.10.0's handler wrote: a byte per block
  writeFileSync(blockList, Buffer.from([1, 0, 1]));

  ctx.handler.answerWarm({ blocks: 5 });
  ctx.warm.start({ impID: 'imp-1', name: 'dev', memFile, blockList });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      /^INFO impd\.imps imp=dev warmed the whole memory file in \d+ms: 5 blocks of 2 MiB$/u.test(
        line,
      ),
    );
  });

  expect(ctx.handler.readWarmRuns().map((run) => run.mode)).toStrictEqual([
    '--count-blocks',
    '--count-data',
    '--warm',
  ]);
});

test('it counts the whole file when the handler refuses the recorded blocks', async () => {
  const ctx = setupTest();
  const memFile = join(ctx.directoryPath, 'mem');
  const blockList = join(ctx.directoryPath, 'mem.touched');

  writeFileSync(blockList, Buffer.from([1]));

  ctx.handler.answerWarm({ blocks: 5, refusesBlockLists: true });
  ctx.warm.start({ impID: 'imp-1', name: 'dev', memFile, blockList });

  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) =>
      /^INFO impd\.imps imp=dev warmed the whole memory file in \d+ms: 5 blocks of 2 MiB$/u.test(
        line,
      ),
    );
  });

  expect(ctx.handler.readWarmRuns().map((run) => run.mode)).toStrictEqual([
    '--count-data',
    '--warm',
  ]);

  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.startsWith(
      'WARNING impd.imps imp=dev the recorded blocks of the memory file cannot be counted, so the whole file is: ',
    ),
  );
});
