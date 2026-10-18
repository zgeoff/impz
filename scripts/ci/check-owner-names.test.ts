import { expect, onTestFinished, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOwnerNames } from './check-owner-names';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'owner-names-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root };
}

test('it passes files that use only invented names and placeholders', async () => {
  const ctx = await setupTest();

  const domain = createHash('sha256').update('owner.example').digest('hex');
  const login = createHash('sha256').update('pat').digest('hex');

  await Bun.write(
    join(ctx.root, 'scripts/lib.sh'),
    [
      'url=https://imp.example.com',
      'host=imp-vm.notowner.example',
      'home=/home/me/projects',
      'ref=op://$IMP_OP_VAULT/item/secret',
      'other=op://{vault}/item',
      String.raw`sed -e 's#op://vault/#op://\$IMP_OP_VAULT/#'`,
      'doc=op://<vault>/item op://vault/item op://example/item',
      '',
    ].join('\n'),
  );

  expect(
    checkOwnerNames(ctx.root, ['scripts/lib.sh'], {
      domains: new Set([domain]),
      logins: new Set([login]),
    }),
  ).toStrictEqual([]);
});

test('it reports the owner domain, home path, and vault by file and line', async () => {
  const ctx = await setupTest();

  const domain = createHash('sha256').update('owner.example').digest('hex');
  const login = createHash('sha256').update('pat').digest('hex');

  await Bun.write(
    join(ctx.root, 'e2e/a.ts'),
    "const url = 'https://imp.owner.example';\nconst apex = 'OWNER.example';\n",
  );

  await Bun.write(
    join(ctx.root, 'notes/guide.md'),
    'Read `op://team-vault/item/secret`.\n\nThe key sits in /Users/pat/.ssh.\n',
  );

  expect(
    checkOwnerNames(ctx.root, ['e2e/a.ts', 'notes/guide.md'], {
      domains: new Set([domain]),
      logins: new Set([login]),
    }),
  ).toStrictEqual([
    { file: 'e2e/a.ts', line: 1, message: 'owner domain' },
    { file: 'e2e/a.ts', line: 2, message: 'owner domain' },
    { file: 'notes/guide.md', line: 1, message: 'vault outside the allow list' },
    { file: 'notes/guide.md', line: 3, message: 'owner home path' },
  ]);
});

test('it skips a file that is gone from the tree or binary', async () => {
  const ctx = await setupTest();

  // a vault outside the allow list, behind a NUL byte
  await Bun.write(join(ctx.root, 'images/logo.bin'), '\0op://team-vault/item/secret\n');

  expect(
    checkOwnerNames(ctx.root, ['images/logo.bin', 'deleted.ts'], {
      domains: new Set(),
      logins: new Set(),
    }),
  ).toStrictEqual([]);
});
