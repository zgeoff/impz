import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-touched-pages-bench-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'checkout', 'scripts', 'dev'), { recursive: true });
  mkdirSync(join(directory, 'checkout', 'scripts', 'bench'), { recursive: true });
  writeFileSync(join(directory, 'summary'), '');

  return {
    checkout: join(directory, 'checkout'),
    calls: join(directory, 'calls'),
    stepSummary: join(directory, 'summary'),
    scriptPath: join(import.meta.dir, 'run-touched-pages-bench.ts'),
  };
}

test('it measures on a dev instance it starts and stops, and writes the result and the job summary', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.checkout, 'scripts', 'dev', 'dev.sh'),
    `#!/bin/sh\necho "dev.sh $1" >> '${ctx.calls}'\n[ "$1" = token ] && echo tok_bench\nexit 0\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(ctx.checkout, 'scripts', 'bench', 'measure-touched-pages.ts'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync('${ctx.calls}', \`measure \${process.env['IMP_URL']} \${process.env['IMP_TOKEN']}\\n\`);\nconsole.log('{"touched": 12}');\n`,
  );

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .cwd(ctx.checkout)
    .env({ ...process.env, GITHUB_STEP_SUMMARY: ctx.stepSummary })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '{"touched": 12}\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe(
    [
      'dev.sh up',
      'dev.sh token',
      'measure http://localhost:7070 tok_bench',
      'dev.sh down',
      '',
    ].join('\n'),
  );

  expect(readFileSync(join(ctx.checkout, '.cache', 'bench', 'touched-pages.json'), 'utf8')).toBe(
    '{"touched": 12}\n',
  );

  expect(readFileSync(ctx.stepSummary, 'utf8')).toBe('```json\n{"touched": 12}\n```\n');
});

test('it fails, writing no summary, when the measure fails', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.checkout, 'scripts', 'dev', 'dev.sh'),
    `#!/bin/sh\necho "dev.sh $1" >> '${ctx.calls}'\nexit 0\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(ctx.checkout, 'scripts', 'bench', 'measure-touched-pages.ts'),
    'process.exit(1);\n',
  );

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .cwd(ctx.checkout)
    .env({ ...process.env, GITHUB_STEP_SUMMARY: ctx.stepSummary })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.stepSummary, 'utf8')).toBe('');
});
