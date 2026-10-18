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

test.each([
  ['a subdomain of the owner domain', 'https://deep.imp.owner.example:8443/mcp', 'owner domain'],
  ['the owner domain in capitals', 'Host: OWNER.EXAMPLE', 'owner domain'],
  ['the owner domain with a trailing dot', 'dig owner.example.', 'owner domain'],
  ['the owner domain in an email', 'mail pat@owner.example', 'owner domain'],
  ['a macOS home path', 'cd /Users/pat/projects', 'owner home path'],
  ['a home path that ends a sentence', 'It sits in /home/pat.', 'owner home path'],
  ['a home path before a comma', 'Use /home/pat, then stop.', 'owner home path'],
  ['a home path in capitals', 'cd /Users/Pat/notes', 'owner home path'],
  [
    'a vault outside the allow list',
    'op read op://team-vault/item/token',
    'vault outside the allow list',
  ],
  ['an allowed vault in capitals', 'op read op://Vault/item/token', 'vault outside the allow list'],
  [
    'a vault that only starts with an allowed name',
    'op read op://vaults/item',
    'vault outside the allow list',
  ],
  [
    'a vault that extends an allowed name',
    'op read op://example-real/item',
    'vault outside the allow list',
  ],
  ['an empty vault name', 'op read op:///item/token', 'vault outside the allow list'],
])('it refuses %s', async (_label, line, message) => {
  const ctx = await setupTest();

  const domain = createHash('sha256').update('owner.example').digest('hex');
  const login = createHash('sha256').update('pat').digest('hex');

  await Bun.write(join(ctx.root, 'notes/a.md'), `${line}\n`);

  expect(
    checkOwnerNames(ctx.root, ['notes/a.md'], {
      domains: new Set([domain]),
      logins: new Set([login]),
    }),
  ).toStrictEqual([{ file: 'notes/a.md', line: 1, message }]);
});

test.each([
  ['a domain that only ends with the owner domain text', 'https://notowner.example'],
  ['a domain that extends the owner domain', 'https://owner.example.org'],
  ['a domain with a hyphen in place of the dot', 'https://owner-example.com'],
  ['a login that only starts with the owner login', 'cd /home/patrick/projects'],
  ['an allowed vault', 'op read op://vault/item/token'],
  ['a vault placeholder', 'op read op://$IMP_OP_VAULT/item/token'],
])('it passes %s', async (_label, line) => {
  const ctx = await setupTest();

  const domain = createHash('sha256').update('owner.example').digest('hex');
  const login = createHash('sha256').update('pat').digest('hex');

  await Bun.write(join(ctx.root, 'notes/a.md'), `${line}\n`);

  expect(
    checkOwnerNames(ctx.root, ['notes/a.md'], {
      domains: new Set([domain]),
      logins: new Set([login]),
    }),
  ).toStrictEqual([]);
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
