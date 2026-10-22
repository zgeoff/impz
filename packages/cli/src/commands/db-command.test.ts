import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import packageJson from '@impz/daemon/package.json' with { type: 'json' };
import { MIGRATIONS, startStubImpdRelease, startTestImpd } from '@impz/daemon/testing';
import * as z from 'zod';
import { readJsonOutput } from '../test-utils/read-json-output';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  return {
    stack,
    rootToken,
    dataDir: harness.dataDir,
    sendRequest: (request: Request) => harness.impd.api.app.handle(request),
    url: harness.url,
  };
}

test('it makes no database copy on an impd from before databaseCopy (0.30.0)', async () => {
  const ctx = await setupTest();

  const older = startStubImpdRelease(ctx.stack, ctx.sendRequest, {
    withoutFeatures: ['databaseCopy'],
  });

  const result = await runCLIInProcess({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { IMP_URL: older.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd is older than 0.30.0 and would not know the call; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/features']);
});

test('it prints the database copy’s fields in the order a restore script reads them', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    path: join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite'),
    sizeBytes: expect.any(Number) as unknown,
    lastMigration: Object.keys(MIGRATIONS).toSorted().at(-1),
    impVersion: packageJson.version,
    createdAt: expect.any(String) as unknown,
    integrity: 'ok',
  });

  const fields = z.record(z.string(), z.unknown()).parse(printed);

  expect(Object.keys(fields)).toStrictEqual([
    'path',
    'sizeBytes',
    'lastMigration',
    'impVersion',
    'createdAt',
    'integrity',
  ]);
});

test('it prints the database copy as --json output in the shape of the committed schema', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.code).toBe(0);
  expect(readJsonOutput('db copy', result.stdout).data).toStrictEqual(JSON.parse(result.stdout));
});
