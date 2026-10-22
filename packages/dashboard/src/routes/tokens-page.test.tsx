import { expect, onTestFinished, test } from 'bun:test';
import { buildMockTokenSshKeyRecord } from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import invariant from 'tiny-invariant';
import { renderApp } from '../test-utils/render-app';
import { startDashboardImpd } from '../test-utils/start-dashboard-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardImpd = await startDashboardImpd(stack);

  return { client: dashboardImpd.harness.client, logIn: dashboardImpd.logIn };
}

test('it makes a token limited to some imps and shows its secret', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();
  const admin = await ctx.client.tokens.create({ name: 'admin', scope: 'manage' });

  await ctx.logIn(admin.secret);

  const rendered = renderApp('/tokens');

  const field = await rendered.findByLabelText('Name');

  await user.type(field, 'ci');
  await user.selectOptions(rendered.getByLabelText('Scope'), 'exec');
  await user.type(rendered.getByLabelText('Imps'), 'dev-*, ci-*');
  await user.click(rendered.getByRole('button', { name: 'Make token' }));

  const card = await rendered.findByRole('region', { name: 'Secret of ci' });
  const row = await rendered.findByRole('row', { name: /ci/u });
  const tokens = await ctx.client.tokens.list();

  const token = tokens.find((listed) => listed.name === 'ci');

  invariant(token);

  expect(within(card).getByText(/^imp_/u)).toBeInTheDocument();
  expect(within(row).getByText('dev-*, ci-*')).toBeInTheDocument();
  expect(token).toMatchObject({ scope: 'exec', imps: ['dev-*', 'ci-*'], grantable: [] });
});

test('it deletes a token after a confirm', async () => {
  const user = userEvent.setup();

  const ctx = await setupTest();
  const admin = await ctx.client.tokens.create({ name: 'admin', scope: 'manage' });

  await ctx.client.tokens.create({ name: 'old', scope: 'read' });
  await ctx.logIn(admin.secret);

  const rendered = renderApp('/tokens');

  const row = await rendered.findByRole('row', { name: /old/u });

  await user.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await rendered.findByRole('dialog', { name: 'Delete old?' });

  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => {
    expect(rendered.queryByRole('row', { name: /old/u })).toBeNull();
  });

  const tokens = await ctx.client.tokens.list();

  expect(tokens.map((token) => token.name)).not.toContain('old');
});

test('it hides the tokens link from a caller limited to some imps', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  await ctx.logIn(dev.secret);

  const rendered = renderApp('/');

  await rendered.findByText('dev (manage)');

  expect(rendered.queryByRole('link', { name: 'Tokens' })).toBeNull();
});

test('it links to tokens for a caller that manages the whole host', async () => {
  const ctx = await setupTest();
  const admin = await ctx.client.tokens.create({ name: 'admin', scope: 'manage' });

  await ctx.logIn(admin.secret);

  const rendered = renderApp('/');

  const link = await rendered.findByRole('link', { name: 'Tokens' });

  expect(link).toBeInTheDocument();
});

test('it lists the SSH keys bound to each token', async () => {
  const ctx = await setupTest();

  const key = buildMockTokenSshKeyRecord();

  const admin = await ctx.client.tokens.create({ name: 'admin', scope: 'manage' });

  await ctx.client.tokens.create({
    name: 'laptop',
    scope: 'exec',
    sshKeys: [`${key.publicKey} me@laptop`],
  });

  await ctx.logIn(admin.secret);

  const rendered = renderApp('/tokens');

  const row = await rendered.findByRole('row', { name: /laptop/u });

  expect(within(row).getByText(`me@laptop ${key.fingerprint}`)).toBeInTheDocument();
});
