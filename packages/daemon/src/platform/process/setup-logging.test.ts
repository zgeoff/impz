import { expect, onTestFinished, test } from 'bun:test';
import { getLogger, resetSync } from '@logtape/logtape';
import { getImpdLogger } from './get-impd-logger';
import { setupLogging } from './setup-logging';
import { withImpLogContext } from './with-imp-log-context';

function setupTest() {
  const lines: string[] = [];

  setupLogging((line) => {
    lines.push(line);
  });

  onTestFinished(() => {
    resetSync();
  });

  return { lines };
}

test('it writes a line with the level, the category and the message', () => {
  const ctx = setupTest();

  getImpdLogger('broker').info('listening on :{port}', { port: 8443 });

  expect(ctx.lines).toStrictEqual(['INFO impd.broker listening on :8443\n']);
});

test('it writes the imp a logger is about', () => {
  const ctx = setupTest();

  getImpdLogger('imps').with({ imp: 'web' }).warning('asleep');

  expect(ctx.lines).toStrictEqual(['WARNING impd.imps imp=web asleep\n']);
});

test('it writes the imp of the context a line is written in, across an await', async () => {
  const ctx = setupTest();

  await withImpLogContext('web', async () => {
    await Promise.resolve();

    getImpdLogger('memory').info('grew');
  });

  expect(ctx.lines).toStrictEqual(['INFO impd.memory imp=web grew\n']);
});

test('it writes an error value with its message', () => {
  const ctx = setupTest();

  getImpdLogger('api').error('rpc failed: {failure}', { failure: new Error('boom') });

  expect(ctx.lines).toSatisfyAll((line: string) => line.startsWith('ERROR impd.api rpc failed: '));
  expect(ctx.lines.join('')).toInclude('boom');
});

test('it escapes the line breaks inside a message, so each record is one line', () => {
  const ctx = setupTest();

  getImpdLogger('api').error('first\r\nsecond {failure}', { failure: new Error('boom') });

  expect(ctx.lines).toSatisfyAll((line: string) => line.indexOf('\n') === line.length - 1);
  expect(ctx.lines.join('')).toStartWith(String.raw`ERROR impd.api first\r\nsecond `);
});

test('it writes no line for a logger outside impd', () => {
  const ctx = setupTest();

  getLogger(['other']).info('elsewhere');

  expect(ctx.lines).toStrictEqual([]);
});

test('it writes each line to stdout when given no writer', async () => {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `import { getImpdLogger } from './get-impd-logger';
import { setupLogging } from './setup-logging';
setupLogging();
getImpdLogger('gc').info('removed 2 drives');`,
    ],
    { cwd: import.meta.dir, stdout: 'pipe' },
  );

  onTestFinished(() => {
    child.kill();
  });

  const stdout = await new Response(child.stdout).text();

  expect(stdout).toBe('INFO impd.gc removed 2 drives\n');
});
