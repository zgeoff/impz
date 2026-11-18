import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { seedServiceFiles } from './seed-service-files';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it writes a token entry per client and a clients entry for each client with imps', async () => {
  const ctx = setupTest();

  const seeded = await seedServiceFiles(ctx.stack, 'https://imp.example/mcp', [
    { name: 'reader', scopes: ['read'], imps: ['orchard-*'] },
    { name: 'unlimited', scopes: ['exec'], imps: null },
  ]);

  const tokensText = await readFile(seeded.files.tokenFile, 'utf8');
  const clientsText = await readFile(seeded.files.clientsFile, 'utf8');

  expect(JSON.parse(tokensText)).toMatchObject({
    resource: 'https://imp.example/mcp',
    clients: { reader: { scopes: ['read'] }, unlimited: { scopes: ['exec'] } },
  });

  expect(JSON.parse(clientsText)).toStrictEqual({ clients: { reader: { imps: ['orchard-*'] } } });
});

test('it finds the secret it minted for a client and throws for an unknown name', async () => {
  const ctx = setupTest();

  const seeded = await seedServiceFiles(ctx.stack, 'https://imp.example/mcp', [
    { name: 'reader', scopes: ['read'], imps: null },
  ]);

  expect(seeded.findSecret('reader')).toBeString();
  expect(() => seeded.findSecret('stranger')).toThrow('no secret for stranger');
});

test('it writes the token file again for the clients given', async () => {
  const ctx = setupTest();

  const seeded = await seedServiceFiles(ctx.stack, 'https://imp.example/mcp', [
    { name: 'reader', scopes: ['read'], imps: null },
    { name: 'writer', scopes: ['exec'], imps: null },
  ]);

  await seeded.writeTokenFile([{ name: 'reader', scopes: ['read'], imps: null }]);

  const tokensText = await readFile(seeded.files.tokenFile, 'utf8');

  expect(JSON.parse(tokensText)).toMatchObject({ clients: { reader: { scopes: ['read'] } } });
  expect(tokensText).not.toContain('writer');
});

test('it removes the folder that holds the files when the stack disposes', async () => {
  const stack = new AsyncDisposableStack();

  const seeded = await seedServiceFiles(stack, 'https://imp.example/mcp', []);

  expect(existsSync(seeded.files.tokenFile)).toBe(true);

  await stack.disposeAsync();

  expect(existsSync(seeded.files.tokenFile)).toBe(false);
});
